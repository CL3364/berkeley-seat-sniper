/**
 * src/notify/index.ts
 *
 * Delivery layer for Berkeley Seat Sniper. Provider-agnostic dispatch behind one
 * interface so the channel (Resend / SMTP / a future Discord swap) can change
 * without touching the worker or backend.
 *
 * Public API:
 *
 *   createNotifier(options?)  → Notifier
 *     .dispatch(event)          → DispatchResult  (alert email + push, idempotent)
 *     .sendConfirmation(input)  → SendResult      (confirmation email, ?confirm=)
 *     .sendManageLink(input)    → SendResult      (manage-link email, ?token=)
 *     .alertOperator(key, d)    → void            (parser-broke; suppression-exempt)
 *     .outbox                   → OutboxEntry[]    (noop transport test surface)
 *
 * The backend and worker both build their own instance via createNotifier() at
 * boot (server lane: defaultNotifierPort; worker lane: poller) and call the
 * INSTANCE methods above — there is no module-level singleton sender.
 *
 * Transport is selected by MAIL_TRANSPORT:
 *   noop  (default) — no network calls; outbox captures sent mail (FR-8)
 *   real            — Resend adapter (env-keyed; never hardcoded)
 *
 * Fail-loud env (spec §6 / D7): with MAIL_TRANSPORT=noop nothing extra is
 * required. For ANY non-noop transport, construction THROWS unless BOTH
 * OPERATOR_EMAIL (FR-14), APP_BASE_URL (emailed links, §4), and the selected
 * provider's required secrets are set. VAPID is optional as a complete unit:
 * all three values unset disables push; a partial set fails construction.
 *
 * PII discipline (constitution / §6 / AC-8):
 *   - email / tokens / push endpoints + keys are NEVER printed in any log line.
 *   - Log lines carry subscriberId + counts only.
 *   - Only the branded noop transport retains full sent-mail snapshots. Real
 *     transports retain no recipient, body, or token data in process memory.
 *
 * The legacy direct-alert surface has a bounded same-process duplicate
 * fast-path. Durable at-least-once semantics live in `mail_outbox` and the
 * `MailDispatcher` exported below.
 *
 * Suppression (FR-12): checked before EVERY subscriber-facing send (alert,
 * confirmation, manage-link). A suppressed address receives nothing and the
 * outbox records nothing for it. Operator alerts are exempt (internal).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { NotifyEvent, PushAlertPayload } from '../shared/seat-state';
import { PushAlertPayloadSchema } from '../shared/seat-state';
import type {
  Notifier,
  OutboxEntry,
  DispatchResult,
  SendResult,
  Transport,
  TransportMessage,
  ConfirmationInput,
  ManageLinkInput,
  SuppressionChecker,
  PushDeps,
  PushTarget,
} from './types';
import { createNoopTransport } from './transports/noop';
import { createRealTransport } from './transports/smtp';
import { createWebPushTransport } from './transports/push';
import {
  renderSeatOpenEmail,
  renderConfirmationEmail,
  renderManageLinkEmail,
  renderOperatorAlert,
} from './render';
import { buildConfirmUrl, buildManageUrl, buildListUnsubscribeHeaders } from './links';
import { parseResendWebhookSecret } from './resend-webhook-secret';
import { assertProductionMailRuntime, assertProductionMailTransport } from './runtime-config';
import { EmailSchema } from '../shared/api';
import { isReservedDeploymentHostname } from '../shared/deployment-host';
import { mintToken as defaultMintToken } from '../server/token';

// ---------------------------------------------------------------------------
// Notifier factory
// ---------------------------------------------------------------------------

export interface NotifierOptions {
  /**
   * Override the transport directly (tests wire a noop without touching env).
   * When provided, MAIL_TRANSPORT and provider-specific env validation are
   * skipped because the caller owns transport selection. An injected non-noop
   * transport still requires TOKEN_SECRET because it can send token links.
   */
  transport?: Transport;

  /**
   * Sender address. Falls back to MAIL_FROM, then a local default. The real
   * transport validates MAIL_FROM at construction, so this only matters for the
   * noop path.
   */
  from?: string;

  /**
   * Operator destination for `alertOperator` (FR-14). Falls back to
   * OPERATOR_EMAIL. REQUIRED for any non-noop transport (fail-loud at
   * construction); there is NO silent fall-through to `from`.
   */
  operatorEmail?: string;

  /**
   * Base URL for emailed links (`${APP_BASE_URL}/?confirm=` / `?token=`, §4).
   * Falls back to APP_BASE_URL. REQUIRED for any non-noop transport (fail-loud).
   */
  appBaseUrl?: string;

  /**
   * Suppression checker (FR-12). Injected so the notify lane needn't hold a db
   * handle. Defaults to the repo's `isSuppressed` (lazily wired from src/db).
   * Tests inject a fake.
   */
  isSuppressed?: SuppressionChecker;

  /**
   * Push subscriptions + cleanup + transport (FR-15 / D10). Injected. Defaults
   * to the repo's push CRUD + the real web-push transport (VAPID from env;
   * unset → push silently disabled). Tests inject a fake transport.
   */
  /** `null` disables push construction for processes that never dispatch alerts. */
  push?: PushDeps | null;
}

/** Local default base URL used ONLY on the noop path (dev/test/CI). */
const NOOP_DEFAULT_BASE_URL = 'http://localhost:5173';
const MAX_RECENT_DELIVERY_KEYS = 10_000;
const PUSH_FANOUT_CONCURRENCY = 5;
const GLOBAL_PUSH_CONCURRENCY = 20;

/** Validate the public origin before embedding bearer tokens in real mail. */
function requireHttpsAppOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('APP_BASE_URL must be an absolute HTTPS origin');
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      'APP_BASE_URL must be an absolute HTTPS origin with no credentials, path, query, or fragment',
    );
  }
  const hostname = url.hostname.toLowerCase();
  const isLiteralIp = hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(hostname);
  const isLocalName = /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(hostname);
  if (
    !hostname.includes('.') ||
    isLiteralIp ||
    isLocalName ||
    (process.env.NODE_ENV === 'production' && isReservedDeploymentHostname(hostname))
  ) {
    throw new Error('APP_BASE_URL must use a real public deployment hostname');
  }
  return url.origin;
}

/**
 * Create a Notifier. Call once per process (or per test suite). Safe to share
 * across concurrent dispatch calls: duplicate in-flight calls share the same
 * delivery promise, and completed keys use a bounded local fast-path cache.
 *
 * Usage:
 *   // production (reads MAIL_TRANSPORT/APP_BASE_URL/OPERATOR_EMAIL from env)
 *   const notifier = createNotifier();
 *
 *   // test usage (explicit noop, inspect outbox)
 *   const notifier = createNotifier({ transport: createNoopTransport() });
 *   await notifier.dispatch(event);
 *   notifier.outbox; // [{ kind: 'alert', subject: '...', ... }]
 */
export function createNotifier(options: NotifierOptions = {}): Notifier {
  assertProductionMailRuntime();
  // The noop-only test outbox is owned here; all records happen in this module.
  const outbox: OutboxEntry[] = [];

  // --- Transport selection + fail-loud env (spec §6 / D7) --------------------
  // Two SEPARATE concerns, previously conflated in a single `isNoop` flag:
  //
  //   (1) envRelaxed — whether to SKIP provider-owned configuration validation
  //       such as OPERATOR_EMAIL and APP_BASE_URL. An injected transport means
  //       the CALLER owns that configuration. TOKEN_SECRET remains mandatory
  //       for every active non-noop transport because token links are shared.
  //
  //   (2) transportIsNoop — whether the ACTIVE transport IS the branded noop
  //       transport (`kind: 'noop'`). This — and ONLY this — gates the
  //       NOOP_OUTBOX_FILE sink below. An injected REAL transport (brand unset)
  //       must NEVER tee subscriber emails + tokens to disk, even with the env
  //       var set (spec v0.3.1: sink honored only when the transport IS noop).
  //
  // Conflating them let an injected real transport + the env var write PII to
  // disk (MED-1). Keeping them separate closes that: env relaxation follows
  // injection; the sink follows the brand.
  let transport: Transport;
  let envRelaxed: boolean;
  if (options.transport) {
    transport = options.transport;
    // Caller owns transport selection → relax provider-specific env checks.
    // Shared TOKEN_SECRET validation and the file-sink brand check still apply.
    envRelaxed = true;
  } else {
    const mailTransport = nonBlank(process.env['MAIL_TRANSPORT']) ?? 'noop';
    envRelaxed = mailTransport === 'noop';
    transport = envRelaxed ? createNoopTransport() : createRealTransport();
  }

  assertProductionMailTransport(transport.kind);

  // The sink gate: honored ONLY when the active transport carries the noop
  // brand. A real transport (injected or env-selected) reports false here.
  const transportIsNoop = transport.kind === 'noop';

  // --- Noop outbox file sink (spec §6 / FR-8, env-gated) ---------------------
  // When NOOP_OUTBOX_FILE is set AND the active transport is the noop transport,
  // every outbox entry is also appended as one NDJSON line to that file at the
  // moment it is pushed. This lets black-box e2e tests and the operator runbook
  // read the confirm/manage links that otherwise live only in the in-process
  // outbox array (noop stdout logs the subject only, per AC-8).
  //
  // OFF by default: unset var → zero file writes, exactly current behavior.
  //
  // A REAL transport must NEVER tee mail to a file even if the var is set — that
  // would write live subscriber emails + tokens to disk in production. So the
  // gate requires `transportIsNoop` (the noop brand, NOT merely "a transport was
  // injected"); if the var is set under a non-noop transport we log one startup
  // warning and ignore it.
  //
  // PII POSTURE (BY DESIGN): when active this file accumulates subscriber emails
  // (`to`) and confirm/manage TOKENS (inside `body`). It is a DEV/TEST-ONLY sink;
  // the path MUST live under a gitignored dir (the e2e config points it at
  // `test-results/`). It is the sanctioned sink — stdout/stderr never carry this
  // data. The sink is disabled on any non-noop transport for exactly this reason.
  const noopOutboxFileRaw = process.env['NOOP_OUTBOX_FILE'];
  let noopOutboxFile: string | undefined;
  if (noopOutboxFileRaw) {
    if (transportIsNoop) {
      noopOutboxFile = noopOutboxFileRaw;
    } else {
      // Real transport + var set: ignore, warn once at construction. Do NOT log
      // the path's contents or any address — just that the var was ignored.
      logWarn('noop_outbox_file_ignored', {
        reason: 'transport_not_noop',
      });
    }
  }

  const from =
    nonBlank(options.from) ??
    nonBlank(process.env['MAIL_FROM']) ??
    'alerts@berkeley-seat-sniper.local';

  // For a non-noop transport, OPERATOR_EMAIL and APP_BASE_URL are REQUIRED.
  // Throw at construction so misconfiguration surfaces at startup, never mid
  // cycle. There is NO `OPERATOR_EMAIL ?? from` fallback (audit B4/D7).
  let operatorEmail = nonBlank(options.operatorEmail) ?? nonBlank(process.env['OPERATOR_EMAIL']);
  const appBaseUrlEnv = nonBlank(options.appBaseUrl) ?? nonBlank(process.env['APP_BASE_URL']);
  let realAppBaseUrl: string | undefined;

  if (!envRelaxed) {
    const caddyBindAddress = nonBlank(process.env['CADDY_BIND_ADDRESS']);
    if (caddyBindAddress && ['127.0.0.1', '::1', 'localhost'].includes(caddyBindAddress)) {
      throw new Error(
        'CADDY_BIND_ADDRESS must be public-facing when a real mail transport sends public links',
      );
    }
    if (!operatorEmail) {
      throw new Error(
        'OPERATOR_EMAIL env var is required for any non-noop mail transport ' +
          '(operator alerts must reach a monitored inbox — FR-14).',
      );
    }
    const parsedOperatorEmail = EmailSchema.safeParse(operatorEmail);
    const operatorDomain = operatorEmail.slice(operatorEmail.lastIndexOf('@') + 1);
    const isProductionPlaceholder =
      process.env.NODE_ENV === 'production' && isReservedDeploymentHostname(operatorDomain);
    if (!parsedOperatorEmail.success || isProductionPlaceholder) {
      throw new Error(
        'OPERATOR_EMAIL must be a valid monitored inbox; placeholder example domains are not allowed in production.',
      );
    }
    operatorEmail = parsedOperatorEmail.data;
    if (!appBaseUrlEnv) {
      throw new Error(
        'APP_BASE_URL env var is required for any non-noop mail transport ' +
          '(emailed confirm/manage links are built from it — spec §4).',
      );
    }
    realAppBaseUrl = requireHttpsAppOrigin(appBaseUrlEnv);
    const mailProvider = nonBlank(process.env['MAIL_PROVIDER']) ?? 'resend';
    if (mailProvider === 'resend') {
      try {
        void parseResendWebhookSecret(process.env['RESEND_WEBHOOK_SECRET']);
      } catch {
        throw new Error('RESEND_WEBHOOK_SECRET is invalid for MAIL_PROVIDER=resend');
      }
    }
  }

  // Probe from the ACTIVE transport, not from the env-relaxation seam.
  // Injected real transports still send token-bearing mail and therefore must
  // fail construction when confirmation/manage links cannot be minted. Only
  // the explicitly branded noop transport is exempt.
  if (!transportIsNoop) {
    void defaultMintToken('__notifier_startup_probe__');
  }

  // Resolved values. On the noop path both have safe local defaults so the
  // whole pipeline is verifiable without env (FR-8).
  const appBaseUrl = realAppBaseUrl ?? appBaseUrlEnv ?? NOOP_DEFAULT_BASE_URL;
  const operatorTo = operatorEmail ?? from;

  // --- Suppression checker (FR-12) -------------------------------------------
  // Default: lazily wire the repo's isSuppressed from src/db (imports fine —
  // the lane owns no db handle, so we resolve one on first use). Tests inject.
  const isSuppressed: SuppressionChecker =
    options.isSuppressed ?? (options.transport ? async () => false : defaultSuppressionChecker());

  /** Suppression gate (FR-12). Lookup failure fails closed for this attempt. */
  async function checkSuppressed(email: string, ctx: Record<string, unknown>): Promise<boolean> {
    try {
      return await isSuppressed(email);
    } catch {
      // Emit a fixed classification only: database exceptions may echo bound
      // subscriber data in both their message and dynamic type metadata.
      logError('suppression_check_failed', {
        ...ctx,
        classification: 'suppression_dependency_failed',
      });
      throw new SuppressionCheckError();
    }
  }

  // --- Push deps (FR-15) -----------------------------------------------------
  // Default: repo push CRUD + the real web-push transport (VAPID from env).
  const push: PushDeps =
    options.push === null ? disabledPushDeps() : (options.push ?? defaultPushDeps());
  const sendPushLimited = createConcurrencyLimiter(GLOBAL_PUSH_CONCURRENCY);

  // The durable DB mail_outbox is the source of truth. These local
  // structures are only fast paths: in-flight callers share one delivery
  // Promise (and therefore one success/failure), while the bounded insertion-
  // ordered Map avoids a hot duplicate immediately re-sending without retaining
  // keys forever.
  const inFlightDeliveries = new Map<string, Promise<DispatchResult>>();
  const recentlyDeliveredKeys = new Map<string, true>();

  function rememberDelivered(key: string): void {
    recentlyDeliveredKeys.delete(key);
    recentlyDeliveredKeys.set(key, true);
    if (recentlyDeliveredKeys.size > MAX_RECENT_DELIVERY_KEYS) {
      const oldest = recentlyDeliveredKeys.keys().next().value as string | undefined;
      if (oldest !== undefined) recentlyDeliveredKeys.delete(oldest);
    }
  }

  /**
   * Record one entry in the noop-only in-memory outbox and, when the env-gated
   * noop file sink is active, append it as ONE NDJSON line at the same moment.
   *
   * Race-safety: the append is SYNCHRONOUS (`appendFileSync`), so by the time
   * this function returns — and therefore before the HTTP response that follows
   * the send resolves — the line is flushed to the OS. A black-box test reading
   * the file immediately after the response cannot race a pending async write.
   * The synchronous cost is acceptable: the sink is dev/test-only and never
   * enabled under a real transport.
   *
   * Failure isolation: a file-write error must NOT break dispatch/sends. We
   * catch it, emit one fixed classification, and continue — the in-memory
   * outbox push has already happened, so the live pipeline is unaffected.
   */
  function recordOutbox(entry: OutboxEntry): void {
    if (!transportIsNoop) return;
    outbox.push(entry);
    if (!noopOutboxFile) return;
    try {
      // The NDJSON line is exactly the pinned shape { kind, to, subject, body,
      // sentAt } — nothing more (no idempotencyKey/detail), so the file format
      // is stable for test/runbook consumers.
      const line =
        JSON.stringify({
          kind: entry.kind,
          to: entry.to,
          subject: entry.subject,
          body: entry.body,
          sentAt: entry.sentAt,
        }) + '\n';
      mkdirSync(dirname(noopOutboxFile), { recursive: true });
      appendFileSync(noopOutboxFile, line, 'utf8');
    } catch {
      // Configured paths and platform exception text are not log-safe.
      logError('noop_outbox_file_write_failed', {
        classification: 'filesystem_write_failed',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // dispatch — alert email (kind 'alert') + push fan-out (FR-4/FR-15)
  // ---------------------------------------------------------------------------

  function dispatch(event: NotifyEvent, manageToken?: string): Promise<DispatchResult> {
    const key = `${event.subscriberId}:${event.classKey}:${event.openedAt}`;

    // Join an in-flight attempt rather than returning a premature dedupe result:
    // if the original provider call fails, every caller must observe that
    // failure and leave the durable ledger unmarked.
    const inFlight = inFlightDeliveries.get(key);
    if (inFlight) {
      logInfo('notify_join_inflight', {
        subscriberId: event.subscriberId,
        classKey: event.classKey,
        idempotencyKey: key,
      });
      return inFlight;
    }

    if (recentlyDeliveredKeys.has(key)) {
      logInfo('notify_dedupe', {
        subscriberId: event.subscriberId,
        classKey: event.classKey,
        idempotencyKey: key,
      });
      return Promise.resolve({
        sent: false,
        idempotencyKey: key,
        suppressed: false,
        pushed: 0,
      });
    }

    const operation = (async (): Promise<DispatchResult> => {
      try {
        // Suppression is address/mail hygiene (FR-12), not account suspension.
        // Withhold email and outbox retention, but continue alerts-only push to
        // browsers the confirmed subscriber registered independently.
        if (await checkSuppressed(event.email, { subscriberId: event.subscriberId })) {
          logInfo('notify_suppressed', {
            subscriberId: event.subscriberId,
            classKey: event.classKey,
          });
          const pushCompletion = pushAlertToBrowsers(event).catch(() => {
            logError('push_fanout_threw', {
              subscriberId: event.subscriberId,
              classification: 'push_fanout_failed',
            });
            return 0;
          });
          return {
            sent: false,
            idempotencyKey: key,
            suppressed: true,
            pushed: 0,
            pushCompletion,
          };
        }

        // The manage/unsubscribe link + RFC 8058 headers need the subscriber's
        // signed token, which the worker supplies at fan-out (NotifyEvent carries
        // none by design — §4). When absent the alert still delivers, sans footer
        // link and sans List-Unsubscribe header.
        const manageUrl = manageToken ? buildManageUrl(appBaseUrl, manageToken) : undefined;
        const { subject, body } = renderSeatOpenEmail(event, manageUrl);
        const headers = manageToken
          ? buildListUnsubscribeHeaders(appBaseUrl, manageToken)
          : undefined;

        try {
          await requireProviderSuccess(
            transport.send({
              to: event.email,
              from,
              subject,
              body,
              headers,
              idempotencyKey: key,
            }),
          );
        } catch (err) {
          // Provider failures get only a fixed log classification.
          logError('notify_send_failed', {
            subscriberId: event.subscriberId,
            classKey: event.classKey,
            classification: 'mail_transport_failed',
          });
          throw err;
        }

        // Record only for the branded noop transport. Real transports retain no
        // recipient/body/token snapshots in memory.
        recordOutbox({
          kind: 'alert',
          to: event.email,
          subject,
          body,
          sentAt: new Date().toISOString(),
          idempotencyKey: key,
        });

        logInfo('notify_sent', {
          subscriberId: event.subscriberId,
          classKey: event.classKey,
          reason: event.reason,
          openSeats: event.openSeats,
          idempotencyKey: key,
        });

        // Email is the durable delivery boundary. Schedule push separately so a
        // slow browser endpoint cannot occupy one of the worker's bounded email
        // slots or delay later subscribers. The push path is globally bounded
        // below and catches/logs every failure itself.
        rememberDelivered(key);
        const pushCompletion = pushAlertToBrowsers(event).catch(() => {
          logError('push_fanout_threw', {
            subscriberId: event.subscriberId,
            classification: 'push_fanout_failed',
          });
          return 0;
        });

        return {
          sent: true,
          idempotencyKey: key,
          suppressed: false,
          pushed: 0,
          pushCompletion,
        };
      } finally {
        // Defer the self-reference until after the async IIFE has returned and
        // `operation` has been initialized. This also handles a suppression
        // checker that throws before its first await without a TDZ error.
        queueMicrotask(() => {
          if (inFlightDeliveries.get(key) === operation) {
            inFlightDeliveries.delete(key);
          }
        });
      }
    })();
    inFlightDeliveries.set(key, operation);
    return operation;
  }

  /**
   * Push the opening to each of the subscriber's registered browsers.
   * ALERTS-ONLY (PushAlertPayloadSchema is alerts-only by construction): no
   * token, no confirm/manage URL ever leaves in a push. Every failure mode is
   * isolated — this function never throws. A 404/410 ("gone") drives endpoint
   * cleanup via the injected repo hook. Returns the count actually pushed.
   */
  async function pushAlertToBrowsers(event: NotifyEvent): Promise<number> {
    if (!push.transport.enabled) return 0;

    let targets: PushTarget[];
    try {
      targets = await push.listPushSubscriptions(event.subscriberId);
    } catch {
      // Listing failed — log by id, never block the (already-sent) email.
      logError('push_list_failed', {
        subscriberId: event.subscriberId,
        classification: 'push_repository_failed',
      });
      return 0;
    }
    if (targets.length === 0) return 0;

    // Validate the alerts-only payload once (no token, no email, no links).
    const payload: PushAlertPayload = PushAlertPayloadSchema.parse({
      kind: 'alert',
      classKey: event.classKey,
      reason: event.reason,
      openSeats: event.openSeats,
      openedAt: event.openedAt,
      // FR-27: carry the reserved count so the service worker can say what it knows
      // instead of claiming "some seats are reserved" on every alert.
      openReserved: event.openReserved ?? null,
    });

    let nextTarget = 0;
    let pushed = 0;
    let failed = 0;
    async function pushWorker(): Promise<void> {
      for (;;) {
        const index = nextTarget;
        nextTarget += 1;
        const target = targets[index];
        if (!target) return;

        let result;
        try {
          result = await sendPushLimited(() => push.transport.send(target, payload));
        } catch {
          // A programmer-error throw from the transport is isolated too — push
          // must never block email. Log by subscriberId only (never endpoint).
          logError('push_send_threw', {
            subscriberId: event.subscriberId,
            classification: 'push_transport_failed',
          });
          failed += 1;
          continue;
        }

        if (result.ok) pushed += 1;
        else if (!result.gone) failed += 1;

        if (result.gone) {
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
      }
    }

    const workers = Math.min(PUSH_FANOUT_CONCURRENCY, targets.length);
    await Promise.all(Array.from({ length: workers }, () => pushWorker()));

    if (failed > 0) {
      logError('push_send_failed', {
        subscriberId: event.subscriberId,
        classKey: event.classKey,
        failed,
        classification: 'push_transport_failed',
      });
    }

    logInfo('push_fanout_done', {
      subscriberId: event.subscriberId,
      classKey: event.classKey,
      targets: targets.length,
      pushed,
      failed,
    });

    return pushed;
  }

  // ---------------------------------------------------------------------------
  // sendConfirmation — confirmation email (kind 'confirmation', ?confirm=token)
  // ---------------------------------------------------------------------------

  async function sendConfirmation(input: ConfirmationInput): Promise<SendResult> {
    // Suppression gate (FR-12) — a suppressed address gets no confirmation mail.
    if (await checkSuppressed(input.email, { subscriberId: input.subscriberId })) {
      logInfo('confirmation_suppressed', { subscriberId: input.subscriberId });
      return { sent: false, suppressed: true };
    }

    const confirmUrl = buildConfirmUrl(appBaseUrl, input.token);
    const { subject, body } = renderConfirmationEmail(confirmUrl);
    const headers = buildListUnsubscribeHeaders(appBaseUrl, input.token);

    await sendSubscriberMail('confirmation', {
      to: input.email,
      from,
      subject,
      body,
      headers,
    });

    logInfo('confirmation_sent', { subscriberId: input.subscriberId });
    return { sent: true, suppressed: false };
  }

  // ---------------------------------------------------------------------------
  // sendManageLink — manage-link email (kind 'manage-link', ?token=token)
  // ---------------------------------------------------------------------------

  async function sendManageLink(input: ManageLinkInput): Promise<SendResult> {
    if (await checkSuppressed(input.email, { subscriberId: input.subscriberId })) {
      logInfo('manage_link_suppressed', { subscriberId: input.subscriberId });
      return { sent: false, suppressed: true };
    }

    const manageUrl = buildManageUrl(appBaseUrl, input.token);
    const { subject, body } = renderManageLinkEmail(manageUrl);
    const headers = buildListUnsubscribeHeaders(appBaseUrl, input.token);

    await sendSubscriberMail('manage-link', {
      to: input.email,
      from,
      subject,
      body,
      headers,
    });

    logInfo('manage_link_sent', { subscriberId: input.subscriberId });
    return { sent: true, suppressed: false };
  }

  /**
   * Send a subscriber-facing message and record the outbox entry. The transport
   * surfaces a failure by throwing; we re-throw so the caller (backend) can
   * treat it per its flow (internal_error on subscribe, swallow-with-log on the
   * non-enumerating resend path — owned by the server lane).
   */
  async function sendSubscriberMail(
    kind: 'confirmation' | 'manage-link',
    message: TransportMessage,
  ): Promise<void> {
    await requireProviderSuccess(transport.send(message));
    recordOutbox({
      kind,
      to: message.to,
      subject: message.subject,
      body: message.body,
      sentAt: new Date().toISOString(),
    });
  }

  // ---------------------------------------------------------------------------
  // alertOperator — operator-facing parser-broke alert (kind 'operator')
  // ---------------------------------------------------------------------------

  async function alertOperator(classKey: string, detail: string): Promise<void> {
    const { subject, body } = renderOperatorAlert(classKey, detail);

    logWarn('parser_broke_alert', {
      classKey,
      classification: 'parser_broke',
    });

    // Operator mail is EXEMPT from the suppression check (internal, FR-12) and
    // carries NO List-Unsubscribe headers (it is not bulk subscriber mail).
    try {
      await requireProviderSuccess(transport.send({ to: operatorTo, from, subject, body }));
    } catch (err) {
      // The debounce owner advances only after this promise resolves. Surface a
      // failure so a transient provider fault cannot falsely mark the episode
      // alerted, and do not create a false outbox success record.
      logError('operator_alert_send_failed', {
        classKey,
        classification: 'mail_transport_failed',
      });
      throw err;
    }

    recordOutbox({
      kind: 'operator',
      to: operatorTo,
      subject,
      body,
      sentAt: new Date().toISOString(),
      detail,
    });
  }

  // ---------------------------------------------------------------------------
  // Return the Notifier
  // ---------------------------------------------------------------------------

  return {
    dispatch,
    sendConfirmation,
    sendManageLink,
    alertOperator,
    get outbox(): OutboxEntry[] {
      return outbox;
    },
  };
}

// ---------------------------------------------------------------------------
// Default injected deps (lazily wired from src/db — the lane owns no handle)
// ---------------------------------------------------------------------------

/**
 * Default suppression checker backed by the repo's `isSuppressed`. Resolves the
 * db handle lazily on first use so importing the notify module never forces a db
 * connection (the worker/backend wire their own; tests inject a fake instead).
 */
function defaultSuppressionChecker(): SuppressionChecker {
  return async (email: string): Promise<boolean> => {
    const { getDb, isSuppressed } = await import('../db');
    return isSuppressed(getDb(), email);
  };
}

/**
 * Default push deps backed by the repo's push CRUD + the real web-push
 * transport. The transport reads VAPID from env; when unset it is `enabled:
 * false` and dispatch skips push silently (legal config, FR-15). The repo calls
 * resolve the db handle lazily.
 */
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

// ---------------------------------------------------------------------------
// Logging helpers — structured, PII-free (subscriberId + counts only, AC-8)
// ---------------------------------------------------------------------------

function logInfo(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}
function logWarn(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'warn', event, ...fields }));
}
function logError(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: 'error', event, ...fields }));
}
/** Treat `.env` entries written as `NAME=` as absent, not configured values. */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** FIFO limiter shared across independent subscriber push fan-outs. */
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
class SuppressionCheckError extends Error {
  constructor() {
    super('suppression status unavailable');
    this.name = 'SuppressionCheckError';
  }
}

/**
 * Legacy direct-send methods still reject on provider failure. Production
 * transports now return typed outcomes; older injected test transports return
 * void on success and remain compatible.
 */
async function requireProviderSuccess(pending: ReturnType<Transport['send']>): Promise<void> {
  const outcome = await pending;
  if (outcome === undefined || outcome.status === 'success') return;
  const error = new Error(`mail provider outcome: ${outcome.status}`);
  error.name = 'MailProviderError';
  throw error;
}

// ---------------------------------------------------------------------------
// Re-exports for the worker, backend, and test-engineer
// ---------------------------------------------------------------------------

export { createMailDispatcher } from './dispatcher';
export type { MailDispatcherOptions } from './dispatcher';
export type {
  Notifier,
  OutboxEntry,
  DispatchResult,
  SendResult,
  MailDispatcher,
  MailDispatchJob,
  MailDispatchResult,
  MailDispatchBatchItem,
  DeadLetterIncidentSurface,
  ProviderOutcome,
} from './types';
export type { NotifyEvent } from '../shared/seat-state';
export { createNoopTransport } from './transports/noop';
export { createWebPushTransport, createFakePushTransport } from './transports/push';
export type { FakePushTransport, RecordedPush } from './transports/push';
