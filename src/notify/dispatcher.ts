import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { EmailSchema } from '../shared/api';
import { ClassKeySchema } from '../shared/class-key';
import { isReservedDeploymentHostname } from '../shared/deployment-host';
import { SubscriberEmailSchema } from '../shared/email';
import {
  NotifyEventSchema,
  PushAlertPayloadSchema,
  type NotifyEvent,
  type PushAlertPayload,
} from '../shared/seat-state';
import { mintOpeningToken, mintToken as defaultMintToken } from '../server/token';
import { buildConfirmUrl, buildListUnsubscribeHeaders, buildManageUrl } from './links';
import {
  renderConfirmationEmail,
  renderDeadLetterIncident,
  renderManageLinkEmail,
  renderOperatorEmail,
  renderSeatOpenEmail,
} from './render';
import { parseResendWebhookSecret } from './resend-webhook-secret';
import { assertProductionMailRuntime, assertProductionMailTransport } from './runtime-config';
import { createNoopTransport } from './transports/noop';
import { createWebPushTransport } from './transports/push';
import { createRealTransport } from './transports/smtp';
import type {
  MailDispatchBatchItem,
  MailDispatchJob,
  MailDispatchResult,
  MailDispatcher,
  DeadLetterIncidentSurface,
  OutboxEntry,
  ProviderOutcome,
  ProviderSuccess,
  PushDeps,
  PushTarget,
  SuppressionChecker,
  TokenMinter,
  Transport,
  TransportMessage,
} from './types';

const NOOP_DEFAULT_BASE_URL = 'http://localhost:5173';
const PREPARE_CONCURRENCY = 20;
const PUSH_FANOUT_CONCURRENCY = 5;
const GLOBAL_PUSH_CONCURRENCY = 20;
const MAX_RECENT_PUSH_JOBS = 10_000;

export interface MailDispatcherOptions {
  transport?: Transport;
  from?: string;
  operatorEmail?: string;
  appBaseUrl?: string;
  isSuppressed?: SuppressionChecker;
  mintToken?: TokenMinter;
  /** `null` disables push for a process that will never dispatch Alerts. */
  push?: PushDeps | null;
}

interface PreparedMail {
  job: MailDispatchJob;
  message: TransportMessage;
  pushCompletion?: Promise<number>;
  operatorDetail?: string;
}

type Preparation =
  | { status: 'ready'; value: PreparedMail }
  | { status: 'done'; result: MailDispatchResult };

/**
 * Build the durable outbox dispatcher. It does not mutate job state: the worker
 * owns claim-fenced complete/defer/dead-letter/cancel operations.
 */
export function createMailDispatcher(options: MailDispatcherOptions = {}): MailDispatcher {
  assertProductionMailRuntime();
  const outbox: OutboxEntry[] = [];
  const configuredTransport = resolveTransport(options.transport);
  const transport = configuredTransport.transport;
  assertProductionMailTransport(transport.kind);
  const transportIsNoop = transport.kind === 'noop';
  const runtime = resolveRuntime(options, configuredTransport.envRelaxed);
  const isSuppressed = options.isSuppressed ?? defaultSuppressionChecker();

  // The default minter is backed by TOKEN_SECRET, so probe it at construction
  // for every ACTIVE non-noop transport, including injected transports whose
  // provider-specific env checks are relaxed. Only the branded noop transport
  // skips this default-minter probe. An explicitly injected token minter is a
  // caller-owned test/integration seam and owns its own validation.
  if (!transportIsNoop && options.mintToken === undefined) {
    void defaultMintToken('__mail_dispatcher_startup_probe__');
  }

  const tokenMinter: TokenMinter =
    options.mintToken ??
    ((subscriberId, issuedAt) => mintOpeningToken(subscriberId, issuedAt.toISOString()));
  const push = options.push === null ? disabledPushDeps() : (options.push ?? defaultPushDeps());
  const pushLimited = createConcurrencyLimiter(GLOBAL_PUSH_CONCURRENCY);
  const noopOutboxFile = resolveNoopOutboxFile(transportIsNoop);
  const pushJobs = new Map<string, Promise<number>>();

  function recordAcceptedOutbox(input: {
    kind: OutboxEntry['kind'];
    message: TransportMessage;
    accepted: ProviderSuccess;
    detail?: string;
  }): void {
    if (!transportIsNoop) return;
    const entry: OutboxEntry = {
      kind: input.kind,
      to: input.message.to,
      subject: input.message.subject,
      body: input.message.body,
      sentAt: input.accepted.acceptedAt.toISOString(),
      ...(input.message.idempotencyKey ? { idempotencyKey: input.message.idempotencyKey } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
    };
    outbox.push(entry);
    if (!noopOutboxFile) return;
    try {
      mkdirSync(dirname(noopOutboxFile), { recursive: true });
      appendFileSync(
        noopOutboxFile,
        `${JSON.stringify({
          kind: entry.kind,
          to: entry.to,
          subject: entry.subject,
          body: entry.body,
          sentAt: entry.sentAt,
        })}\n`,
        'utf8',
      );
    } catch {
      logError('noop_outbox_file_write_failed', {
        classification: 'filesystem_write_failed',
      });
    }
  }

  function recordOutbox(prepared: PreparedMail, accepted: ProviderSuccess): void {
    recordAcceptedOutbox({
      kind: prepared.job.kind,
      message: prepared.message,
      accepted,
      ...(prepared.operatorDetail ? { detail: prepared.operatorDetail } : {}),
    });
  }

  async function prepare(job: MailDispatchJob): Promise<Preparation> {
    if (!validProviderKey(job.providerIdempotencyKey)) {
      return permanent('outbox_provider_key_invalid');
    }

    if (job.kind === 'operator') {
      const detail = job.payload['detail'];
      if (
        job.subscriberId !== null ||
        typeof detail !== 'string' ||
        detail.length < 1 ||
        detail.length > 4_096
      ) {
        return permanent('outbox_operator_shape_invalid');
      }
      const parsedClassKey =
        job.classKey === null ? null : ClassKeySchema.safeParse(job.classKey).data;
      if (job.classKey !== null && parsedClassKey === undefined) {
        return permanent('outbox_operator_class_invalid');
      }
      const rendered = renderOperatorEmail(parsedClassKey ?? null, detail);
      return {
        status: 'ready',
        value: {
          job,
          operatorDetail: detail,
          message: {
            to: runtime.operatorEmail,
            from: runtime.from,
            subject: rendered.subject,
            body: rendered.body,
            idempotencyKey: job.providerIdempotencyKey,
          },
        },
      };
    }

    const subscriberId = job.subscriberId;
    const emailResult = SubscriberEmailSchema.safeParse(job.email);
    if (!subscriberId || !emailResult.success) {
      return permanent('outbox_subscriber_shape_invalid');
    }
    const email = emailResult.data;
    let alertEvent: NotifyEvent | undefined;
    let pushCompletion: Promise<number> | undefined;

    if (job.kind === 'alert') {
      const event = buildPushEvent(job, subscriberId, email);
      if (!event) return permanent('outbox_alert_shape_invalid');
      alertEvent = event;
      // Push is additive and independent of the email/provider outcome. Start
      // it as soon as the durable Alert is valid; never await it here.
      pushCompletion = startPush(job.id, event);
    }

    try {
      if (await isSuppressed(email)) {
        logInfo('mail_suppressed', { jobId: job.id, kind: job.kind });
        return {
          status: 'done',
          result: {
            status: 'suppressed',
            ...(pushCompletion ? { pushCompletion } : {}),
          },
        };
      }
    } catch {
      logError('suppression_check_failed', {
        jobId: job.id,
        kind: job.kind,
        classification: 'suppression_dependency_failed',
      });
      return {
        status: 'done',
        result: withPush(
          { status: 'retryable', errorCode: 'suppression_check_failed' },
          pushCompletion,
        ),
      };
    }

    const issuedAt = durableTokenTimestamp(job);
    if (!issuedAt) {
      return {
        status: 'done',
        result: withPush(
          { status: 'permanent', errorCode: 'outbox_timestamp_invalid' },
          pushCompletion,
        ),
      };
    }

    if (job.kind === 'alert') {
      let token: string;
      try {
        token = await tokenMinter(subscriberId, issuedAt);
      } catch {
        logError('mail_token_mint_failed', {
          jobId: job.id,
          classification: 'token_mint_failed',
        });
        return {
          status: 'done',
          result: withPush({ status: 'retryable', errorCode: 'token_mint_failed' }, pushCompletion),
        };
      }
      const manageUrl = buildManageUrl(runtime.appBaseUrl, token);
      const rendered = renderSeatOpenEmail(alertEvent!, manageUrl);
      return {
        status: 'ready',
        value: {
          job,
          pushCompletion,
          message: {
            to: email,
            from: runtime.from,
            subject: rendered.subject,
            body: rendered.body,
            headers: buildListUnsubscribeHeaders(runtime.appBaseUrl, token),
            idempotencyKey: job.providerIdempotencyKey,
          },
        },
      };
    }

    let token: string;
    try {
      token = await tokenMinter(subscriberId, issuedAt);
    } catch {
      logError('mail_token_mint_failed', {
        jobId: job.id,
        classification: 'token_mint_failed',
      });
      return retryable('token_mint_failed');
    }

    if (job.kind === 'confirmation') {
      const rendered = renderConfirmationEmail(buildConfirmUrl(runtime.appBaseUrl, token));
      return {
        status: 'ready',
        value: {
          job,
          message: {
            to: email,
            from: runtime.from,
            subject: rendered.subject,
            body: rendered.body,
            headers: buildListUnsubscribeHeaders(runtime.appBaseUrl, token),
            idempotencyKey: job.providerIdempotencyKey,
          },
        },
      };
    }

    const rendered = renderManageLinkEmail(buildManageUrl(runtime.appBaseUrl, token));
    return {
      status: 'ready',
      value: {
        job,
        message: {
          to: email,
          from: runtime.from,
          subject: rendered.subject,
          body: rendered.body,
          headers: buildListUnsubscribeHeaders(runtime.appBaseUrl, token),
          idempotencyKey: job.providerIdempotencyKey,
        },
      },
    };
  }

  function buildPushEvent(
    job: MailDispatchJob,
    subscriberId: string,
    email: string,
  ): NotifyEvent | null {
    if (
      job.classKey === null ||
      job.openedAt === null ||
      job.reason === null ||
      !(job.openedAt instanceof Date) ||
      Number.isNaN(job.openedAt.getTime())
    ) {
      return null;
    }
    const openSeats = job.payload['openSeats'];
    const parsed = NotifyEventSchema.safeParse({
      subscriberId,
      email,
      classKey: job.classKey,
      reason: job.reason,
      openSeats,
      openedAt: job.openedAt.toISOString(),
    });
    return parsed.success ? parsed.data : null;
  }

  function startPush(jobId: string, event: NotifyEvent): Promise<number> {
    const existing = pushJobs.get(jobId);
    if (existing) return existing;

    const completion = pushAlert(event).catch(() => {
      logError('push_fanout_failed', {
        subscriberId: event.subscriberId,
        classification: 'push_fanout_failed',
      });
      return 0;
    });
    pushJobs.set(jobId, completion);
    if (pushJobs.size > MAX_RECENT_PUSH_JOBS) {
      const oldest = pushJobs.keys().next().value as string | undefined;
      if (oldest !== undefined && oldest !== jobId) pushJobs.delete(oldest);
    }
    return completion;
  }

  async function pushAlert(event: NotifyEvent): Promise<number> {
    if (!push.transport.enabled) return 0;

    let targets: PushTarget[];
    try {
      targets = await push.listPushSubscriptions(event.subscriberId);
    } catch {
      logError('push_list_failed', {
        subscriberId: event.subscriberId,
        classification: 'push_repository_failed',
      });
      return 0;
    }

    const payload: PushAlertPayload = PushAlertPayloadSchema.parse({
      kind: 'alert',
      classKey: event.classKey,
      reason: event.reason,
      openSeats: event.openSeats,
      openedAt: event.openedAt,
    });
    let cursor = 0;
    let sent = 0;

    async function worker(): Promise<void> {
      for (;;) {
        const target = targets[cursor];
        cursor += 1;
        if (!target) return;
        try {
          const result = await pushLimited(() => push.transport.send(target, payload));
          if (result.ok) {
            sent += 1;
          } else if (result.gone) {
            try {
              await push.deletePushSubscriptionIfMatches(event.subscriberId, target);
              logInfo('push_subscription_pruned', { subscriberId: event.subscriberId });
            } catch {
              logError('push_prune_failed', {
                subscriberId: event.subscriberId,
                classification: 'push_repository_failed',
              });
            }
          }
        } catch {
          logError('push_send_failed', {
            subscriberId: event.subscriberId,
            classification: 'push_transport_failed',
          });
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(PUSH_FANOUT_CONCURRENCY, targets.length) }, async () =>
        worker(),
      ),
    );
    return sent;
  }

  function finalize(prepared: PreparedMail, outcome: ProviderOutcome): MailDispatchResult {
    if (outcome.status === 'success') {
      recordOutbox(prepared, outcome);
      logInfo('mail_provider_accepted', {
        jobId: prepared.job.id,
        kind: prepared.job.kind,
        attempt: prepared.job.attempts,
      });
    }
    return withPush(outcome, prepared.pushCompletion);
  }

  async function sendOne(prepared: PreparedMail): Promise<MailDispatchResult> {
    try {
      const outcome = normalizeProviderOutcome(await transport.send(prepared.message));
      return finalize(prepared, outcome);
    } catch {
      logError('mail_transport_threw', {
        jobId: prepared.job.id,
        kind: prepared.job.kind,
        classification: 'mail_transport_failed',
      });
      return withPush(
        { status: 'retryable', errorCode: 'provider_transport_exception' },
        prepared.pushCompletion,
      );
    }
  }

  async function dispatchBatch(jobs: readonly MailDispatchJob[]): Promise<MailDispatchBatchItem[]> {
    const preparations = await mapWithConcurrency(jobs, PREPARE_CONCURRENCY, prepare);
    const results = new Map<string, MailDispatchResult>();
    const ready: PreparedMail[] = [];

    for (let index = 0; index < preparations.length; index += 1) {
      const preparation = preparations[index];
      const job = jobs[index];
      if (!preparation || !job) continue;
      if (preparation.status === 'done') {
        results.set(job.id, preparation.result);
      } else {
        ready.push(preparation.value);
      }
    }

    // Each job retains its own persistent provider idempotency key. Provider
    // batching is intentionally disabled: the transient membership of a DB
    // claim is not a stable retry/idempotency unit.
    const sent = await mapWithConcurrency(ready, PREPARE_CONCURRENCY, async (prepared) => ({
      prepared,
      result: await sendOne(prepared),
    }));
    for (const item of sent) results.set(item.prepared.job.id, item.result);

    return jobs.map((job) => ({
      jobId: job.id,
      result:
        results.get(job.id) ??
        ({ status: 'retryable', errorCode: 'dispatcher_result_missing' } as const),
    }));
  }

  async function dispatch(job: MailDispatchJob): Promise<MailDispatchResult> {
    const [item] = await dispatchBatch([job]);
    return item?.result ?? { status: 'retryable', errorCode: 'dispatcher_result_missing' };
  }

  async function publishDeadLetterIncident(
    incident: DeadLetterIncidentSurface,
  ): Promise<ProviderOutcome> {
    if (!validDeadLetterIncident(incident)) {
      return {
        status: 'permanent',
        errorCode: 'dead_letter_incident_shape_invalid',
      };
    }

    const rendered = renderDeadLetterIncident({
      incidentId: incident.id,
      mailJobId: incident.mailJobId,
      mailKind: incident.mailKind,
      terminalReason: incident.terminalReason ?? 'not_recorded',
      lastErrorCode: incident.lastErrorCode ?? 'not_recorded',
      openedAt: incident.openedAt,
    });
    const message: TransportMessage = {
      to: runtime.operatorEmail,
      from: runtime.from,
      subject: rendered.subject,
      body: rendered.body,
      idempotencyKey: incident.idempotencyKey,
    };

    try {
      const outcome = normalizeProviderOutcome(await transport.send(message));
      if (outcome.status === 'success') {
        recordAcceptedOutbox({
          kind: 'operator',
          message,
          accepted: outcome,
          detail: `dead-letter incident ${incident.id}`,
        });
        logInfo('dead_letter_incident_published', {
          incidentId: incident.id,
          mailJobId: incident.mailJobId,
          mailKind: incident.mailKind,
        });
      }
      return outcome;
    } catch {
      logError('dead_letter_incident_publish_failed', {
        incidentId: incident.id,
        classification: 'mail_transport_failed',
      });
      return {
        status: 'retryable',
        errorCode: 'provider_transport_exception',
      };
    }
  }

  return {
    dispatch,
    dispatchBatch,
    publishDeadLetterIncident,
    get outbox(): OutboxEntry[] {
      return outbox;
    },
  };
}

function resolveTransport(injected: Transport | undefined): {
  transport: Transport;
  envRelaxed: boolean;
} {
  if (injected) return { transport: injected, envRelaxed: true };
  const selected = process.env['MAIL_TRANSPORT']?.trim() || 'noop';
  return selected === 'noop'
    ? { transport: createNoopTransport(), envRelaxed: true }
    : { transport: createRealTransport(), envRelaxed: false };
}

function resolveRuntime(
  options: MailDispatcherOptions,
  envRelaxed: boolean,
): { from: string; operatorEmail: string; appBaseUrl: string } {
  const from =
    options.from?.trim() || process.env['MAIL_FROM']?.trim() || 'alerts@berkeley-seat-sniper.local';
  let operatorEmail = options.operatorEmail?.trim() || process.env['OPERATOR_EMAIL']?.trim();
  const configuredBase = options.appBaseUrl?.trim() || process.env['APP_BASE_URL']?.trim();

  if (!envRelaxed) {
    if (!operatorEmail) {
      throw new Error('OPERATOR_EMAIL is required for a non-noop mail dispatcher');
    }
    const parsedOperator = EmailSchema.safeParse(operatorEmail);
    const domain = operatorEmail.slice(operatorEmail.lastIndexOf('@') + 1);
    if (
      !parsedOperator.success ||
      (process.env.NODE_ENV === 'production' && isReservedDeploymentHostname(domain))
    ) {
      throw new Error('OPERATOR_EMAIL must be a valid monitored inbox');
    }
    operatorEmail = parsedOperator.data;
    if (!configuredBase) {
      throw new Error('APP_BASE_URL is required for a non-noop mail dispatcher');
    }
    validatePublicAppOrigin(configuredBase);
    const provider = process.env['MAIL_PROVIDER']?.trim() || 'resend';
    if (provider === 'resend') {
      void parseResendWebhookSecret(process.env['RESEND_WEBHOOK_SECRET']);
    }
  }

  return {
    from,
    operatorEmail: operatorEmail || from,
    appBaseUrl: configuredBase || NOOP_DEFAULT_BASE_URL,
  };
}

function validatePublicAppOrigin(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('APP_BASE_URL must be an absolute HTTPS origin');
  }
  const hostname = url.hostname.toLowerCase();
  const literalIp = hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(hostname);
  const localName = /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(hostname);
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    !hostname.includes('.') ||
    literalIp ||
    localName ||
    (process.env.NODE_ENV === 'production' && isReservedDeploymentHostname(hostname))
  ) {
    throw new Error('APP_BASE_URL must be an absolute public HTTPS origin');
  }
}

function resolveNoopOutboxFile(transportIsNoop: boolean): string | undefined {
  const configured = process.env['NOOP_OUTBOX_FILE'];
  if (!configured) return undefined;
  if (transportIsNoop) return configured;
  logWarn('noop_outbox_file_ignored', { reason: 'transport_not_noop' });
  return undefined;
}

function defaultSuppressionChecker(): SuppressionChecker {
  return async (email: string): Promise<boolean> => {
    const { getDb, isSuppressed } = await import('../db');
    return isSuppressed(getDb(), email);
  };
}

function defaultPushDeps(): PushDeps {
  const transport = createWebPushTransport();
  return {
    transport,
    async listPushSubscriptions(subscriberId: string): Promise<PushTarget[]> {
      const { getDb, listPushSubscriptions } = await import('../db');
      return listPushSubscriptions(getDb(), subscriberId);
    },
    async deletePushSubscriptionIfMatches(subscriberId: string, target: PushTarget): Promise<void> {
      const { getDb, deletePushSubscriptionIfMatches } = await import('../db');
      await deletePushSubscriptionIfMatches(getDb(), subscriberId, target);
    },
  };
}

function disabledPushDeps(): PushDeps {
  return {
    transport: {
      enabled: false,
      async send() {
        return { ok: false, gone: false };
      },
    },
    async listPushSubscriptions() {
      return [];
    },
    async deletePushSubscriptionIfMatches() {},
  };
}

function normalizeProviderOutcome(outcome: ProviderOutcome | void): ProviderOutcome {
  return outcome ?? { status: 'success', acceptedAt: new Date() };
}

function durableTokenTimestamp(job: MailDispatchJob): Date | null {
  const timestamp = job.kind === 'alert' ? job.openedAt : job.createdAt;
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) return null;
  return new Date(timestamp.getTime());
}

function withPush(
  outcome: ProviderOutcome | { status: 'suppressed' },
  pushCompletion: Promise<number> | undefined,
): MailDispatchResult {
  return {
    ...outcome,
    ...(pushCompletion ? { pushCompletion } : {}),
  } as MailDispatchResult;
}

function validProviderKey(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && !/[\r\n]/.test(value);
}

function validDeadLetterIncident(incident: DeadLetterIncidentSurface): boolean {
  const boundedId = (value: string): boolean => /^[A-Za-z0-9._:-]{1,256}$/.test(value);
  const boundedClassification = (value: string | null): boolean =>
    value === null || /^[a-z0-9_.:-]{1,128}$/.test(value);
  return (
    boundedId(incident.id) &&
    boundedId(incident.mailJobId) &&
    validProviderKey(incident.idempotencyKey) &&
    ['alert', 'confirmation', 'manage-link', 'operator'].includes(incident.mailKind) &&
    boundedClassification(incident.terminalReason) &&
    boundedClassification(incident.lastErrorCode) &&
    incident.openedAt instanceof Date &&
    !Number.isNaN(incident.openedAt.getTime())
  );
}

function permanent(errorCode: string): Preparation {
  return { status: 'done', result: { status: 'permanent', errorCode } };
}

function retryable(errorCode: string): Preparation {
  return { status: 'done', result: { status: 'retryable', errorCode } };
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await mapper(value);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()),
  );
  return results;
}

function createConcurrencyLimiter(limit: number) {
  let active = 0;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  function release(): void {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  }

  return async function limited<T>(task: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function logInfo(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}

function logWarn(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'warn', event, ...fields }));
}

function logError(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: 'error', event, ...fields }));
}
