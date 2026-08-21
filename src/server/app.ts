/**
 * Hono API for the v0.4 notify-only contract.
 *
 * Subscription and recovery routes write durable `mail_outbox` work through the
 * injected repository. The API process never sends email directly, never stores
 * a raw token/recipient in a job, and never returns a manage token.
 */

import { bodyLimit } from 'hono/body-limit';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { ConfirmSubscriberResult as DbConfirmSubscriberResult } from '../db';
import {
  AddWatchRequestSchema,
  CreateSubscriptionRequestSchema,
  DisablePushRequestSchema,
  EmptyJsonRequestSchema,
  EnablePushRequestSchema,
  PILOT_INVITE_CODE_HEADER,
  RemoveWatchParamsSchema,
  RESEND_WEBHOOK_MAX_BODY_BYTES,
  RESEND_WEBHOOK_SIGNATURE_HEADERS,
  ResendManageLinkRequestSchema,
  ResendWebhookEventSchema,
  TokenParamsSchema,
  suppressionsFromResendEvent,
  type PushKeys,
  type SuppressionReason,
  type WatchFreshness,
} from '../shared/api';
import type { ClassKey } from '../shared/class-key';
import {
  ADMISSION_RETRY_AFTER_SECONDS,
  ADMISSION_UNAVAILABLE_MESSAGE,
  API_ERROR_STATUS,
  RECOVERY_INTERNAL_ERROR_MESSAGE,
  apiError,
} from '../shared/errors';
import { readVapidPublicKey } from '../notify/transports/push';
import { admissionAllowsCreate, readAdmissionPolicy, type AdmissionPolicy } from './admission';
import {
  readBackupReadiness,
  readBackupReadinessConfig,
  type BackupReadinessConfig,
  type BackupReadinessResult,
} from './backup-readiness';
import {
  isCapacityError,
  isConflictError,
  isNotFoundError,
  isSubscriberCapacityError,
  isWatchLimitError,
} from './db-errors';
import {
  readDiskReadiness,
  readDiskReadinessConfig,
  type DiskReadinessConfig,
  type DiskReadinessResult,
} from './disk-readiness';
import { hasValidPushCurvePoint } from './push-keys';
import {
  checkEmailLimit,
  defaultRateLimiter,
  rateLimitMiddleware,
  readRateLimitConfig,
  readProxyTrustPolicy,
  type ClientIpOptions,
  type ProxyTrustPolicy,
  type RateLimitConfig,
  type RateLimiter,
} from './rate-limit';
import { parseResendWebhookSecret } from './resend-webhook-secret';
import { readSourceCapacityConfig, type ServerOutboxHealth } from './repo';
import { mintToken, verifyToken } from './token';
import { verifyResendWebhook } from './webhook-signature';
import { readWorkerReadiness, type WorkerReadinessResult } from './worker-readiness';
import type { NotifierPort } from './notifier-port';

export interface SubscriberRecord {
  id: string;
  email: string;
  confirmed: boolean;
  watches: ClassKey[];
  watchFreshness: WatchFreshness[];
}

export type ConfirmSubscriberResult = DbConfirmSubscriberResult;

export interface SubscriptionRepo {
  healthCheck?(): Promise<void>;
  getOutboxHealth?(): Promise<ServerOutboxHealth>;
  createSubscriber(
    email: string,
    classKeys: ClassKey[],
  ): Promise<{ id: string; watches: ClassKey[]; watchFreshness: WatchFreshness[] }>;
  getSubscriberById(id: string): Promise<SubscriberRecord | null>;
  addWatch(
    subscriberId: string,
    classKey: ClassKey,
  ): Promise<{ watches: ClassKey[]; watchFreshness: WatchFreshness[] }>;
  removeWatch(subscriberId: string, classKey: ClassKey): Promise<void>;
  deleteSubscriber(id: string): Promise<void>;
  confirmSubscriber(id: string): Promise<ConfirmSubscriberResult>;
  suppressEmail(email: string, reason: SuppressionReason): Promise<void>;
  upsertPushSubscription(subscriberId: string, endpoint: string, keys: PushKeys): Promise<void>;
  deletePushSubscriptionForSubscriber(subscriberId: string, endpoint: string): Promise<number>;
  enqueueResendMailByEmail(email: string): Promise<{ enqueued: boolean }>;
}

export interface AppRuntimeOptions extends ClientIpOptions {
  admissionPolicy?: AdmissionPolicy;
  isPushOperational?(publicKey: string): boolean | Promise<boolean>;
  rateLimiter?: RateLimiter;
  rateLimitConfig?: RateLimitConfig;
  capacityRetryAfterSeconds?: number;
  outboxReadinessMaxAgeSeconds?: number;
  requireProductionReadiness?: boolean;
  backupReadinessCheck?(): Promise<BackupReadinessResult>;
  diskReadinessCheck?(): Promise<DiskReadinessResult>;
  workerReadinessCheck?(): Promise<WorkerReadinessResult>;
}

const MAX_JSON_BODY_BYTES = 64 * 1024;

type WebhookLogClassification =
  | 'payload_too_large'
  | 'signature_missing'
  | 'signature_malformed'
  | 'signature_stale'
  | 'signature_mismatch'
  | 'payload_invalid'
  | 'ignored'
  | 'suppressed'
  | 'suppression_persist_failed';

function logWebhook(
  classification: WebhookLogClassification,
  severity: 'info' | 'warn' | 'error' = 'info',
): void {
  const entry = { event: classification };
  if (severity === 'error') console.error(entry);
  else if (severity === 'warn') console.warn(entry);
  else console.log(entry);
}

function signatureLogClassification(
  reason:
    | 'not_configured'
    | 'missing_headers'
    | 'bad_timestamp'
    | 'timestamp_out_of_tolerance'
    | 'bad_signature',
): WebhookLogClassification {
  switch (reason) {
    case 'missing_headers':
      return 'signature_missing';
    case 'bad_timestamp':
      return 'signature_malformed';
    case 'timestamp_out_of_tolerance':
      return 'signature_stale';
    case 'not_configured':
    case 'bad_signature':
      return 'signature_mismatch';
  }
}

function errRes(
  body: ReturnType<typeof apiError>,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function jsonRes(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function admissionUnavailableRes(): Response {
  return errRes(
    apiError('admission_unavailable', ADMISSION_UNAVAILABLE_MESSAGE),
    API_ERROR_STATUS.admission_unavailable,
    { 'Retry-After': String(ADMISSION_RETRY_AFTER_SECONDS) },
  );
}

function recoveryInternalErrorRes(): Response {
  return errRes(
    apiError('internal_error', RECOVERY_INTERNAL_ERROR_MESSAGE),
    API_ERROR_STATUS.internal_error,
  );
}

function capacityExceededRes(capacityRetryAfterSeconds: number): Response {
  return errRes(
    apiError('capacity_exceeded', 'source monitoring capacity is full; please try again later'),
    API_ERROR_STATUS.capacity_exceeded,
    { 'Retry-After': String(capacityRetryAfterSeconds) },
  );
}

function positiveInteger(name: string, raw: number | undefined, fallback: number): number {
  const value = raw ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const requireJsonMediaType: MiddlewareHandler = async (c, next) => {
  const mediaType = c.req.raw.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return errRes(apiError('validation_error', 'Content-Type must be application/json'), 400);
  }
  await next();
};

function resolveToken(
  raw: string,
): { ok: true; subscriberId: string } | { ok: false; res: Response } {
  if (!raw || raw.length > 512) {
    return {
      ok: false,
      res: errRes(apiError('token_invalid', 'invalid or expired token'), 401),
    };
  }
  const result = verifyToken(raw);
  if (!result.ok) {
    return {
      ok: false,
      res: errRes(apiError('token_invalid', 'invalid or expired token'), 401),
    };
  }
  return { ok: true, subscriberId: result.subscriberId };
}

function zodToApiError(error: z.ZodError): ReturnType<typeof apiError> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_root';
    if (!fields[key]) fields[key] = issue.message;
  }
  return apiError('validation_error', 'request validation failed', fields);
}

function mapRepoError(error: unknown, capacityRetryAfterSeconds: number): Response {
  if (isWatchLimitError(error)) {
    return errRes(
      apiError('watch_limit_reached', 'remove a watch before adding another'),
      API_ERROR_STATUS.watch_limit_reached,
    );
  }
  if (isConflictError(error)) {
    return errRes(
      apiError('conflict', 'subscription or watch already exists'),
      API_ERROR_STATUS.conflict,
    );
  }
  if (isNotFoundError(error)) {
    return errRes(apiError('not_found', 'subscriber not found'), API_ERROR_STATUS.not_found);
  }
  if (isCapacityError(error)) {
    return capacityExceededRes(capacityRetryAfterSeconds);
  }
  console.error({
    event: 'internal_error',
    errorName: error instanceof Error ? error.constructor.name : 'unknown',
  });
  return errRes(
    apiError('internal_error', 'an unexpected error occurred'),
    API_ERROR_STATUS.internal_error,
  );
}

async function parseJson(
  c: Context,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return {
      ok: false,
      response: errRes(apiError('validation_error', 'request body must be JSON'), 400),
    };
  }
}

/**
 * Validate server-side prerequisites before any request can create durable
 * work. The worker resolves/mints tokens at dispatch, but production API
 * startup still probes token configuration so it cannot accept unusable jobs.
 */
export function validateServerRuntimeConfig(admissionPolicy?: AdmissionPolicy): {
  vapidPublicKey: string | null;
  admissionPolicy: AdmissionPolicy;
  proxyTrustPolicy: ProxyTrustPolicy;
  backupReadinessConfig: BackupReadinessConfig | null;
  diskReadinessConfig: DiskReadinessConfig | null;
} {
  const resolvedAdmissionPolicy = admissionPolicy ?? readAdmissionPolicy();
  const production = process.env.NODE_ENV === 'production';
  if (production && process.env.DISABLE_RATE_LIMIT === '1') {
    throw new Error('DISABLE_RATE_LIMIT=1 is forbidden in production');
  }
  const vapidPublicKey = readVapidPublicKey();
  const mailTransport = process.env.MAIL_TRANSPORT?.trim() || 'noop';
  const mailProvider = process.env.MAIL_PROVIDER?.trim() || 'resend';
  if (production && mailTransport !== 'real') {
    throw new Error('MAIL_TRANSPORT=real is required in production');
  }
  if (production && mailProvider !== 'resend') {
    throw new Error('MAIL_PROVIDER=resend is required in production');
  }
  if (production && process.env.NOOP_OUTBOX_FILE?.trim()) {
    throw new Error('NOOP_OUTBOX_FILE is forbidden in production');
  }
  if (mailTransport !== 'noop' || production) {
    void mintToken('__startup_config_probe__');
  }
  if (mailTransport !== 'noop') {
    if (mailProvider === 'resend') {
      try {
        void parseResendWebhookSecret(process.env.RESEND_WEBHOOK_SECRET);
      } catch (error) {
        throw new Error(
          `invalid RESEND_WEBHOOK_SECRET for MAIL_PROVIDER=resend: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  return {
    vapidPublicKey,
    admissionPolicy: resolvedAdmissionPolicy,
    proxyTrustPolicy: readProxyTrustPolicy(),
    backupReadinessConfig: readBackupReadinessConfig(),
    diskReadinessConfig: readDiskReadinessConfig(),
  };
}

/**
 * `_legacyNotifier` is retained as an ignored optional parameter for source
 * compatibility with existing test harnesses. v0.4 routes enqueue mail in the
 * database and never call it.
 */
export function createApp(
  repo: SubscriptionRepo,
  _legacyNotifier?: NotifierPort,
  options: AppRuntimeOptions = {},
): Hono {
  const {
    vapidPublicKey,
    admissionPolicy,
    proxyTrustPolicy,
    backupReadinessConfig,
    diskReadinessConfig,
  } = validateServerRuntimeConfig(options.admissionPolicy);
  const limiter = options.rateLimiter ?? defaultRateLimiter();
  if (process.env.NODE_ENV === 'production' && limiter.backend !== 'redis') {
    throw new Error('a connected Redis rate limiter is required in production');
  }
  const limits = options.rateLimitConfig ?? readRateLimitConfig();
  const capacityRetryAfterSeconds = positiveInteger(
    'capacityRetryAfterSeconds',
    options.capacityRetryAfterSeconds,
    readSourceCapacityConfig().visibleTargetSeconds,
  );
  const outboxReadinessMaxAgeSeconds = positiveInteger(
    'outboxReadinessMaxAgeSeconds',
    options.outboxReadinessMaxAgeSeconds,
    positiveIntegerEnv('HEALTH_OUTBOX_MAX_AGE_SECONDS', 300),
  );
  // Production always aggregates worker state. Outside production, explicitly
  // sharing the worker marker opts the API into the same worker/outbox checks
  // without forcing test and CI environments onto a real mail transport.
  const requireAggregateReadiness =
    options.requireProductionReadiness ??
    (process.env.NODE_ENV === 'production' || Boolean(process.env.WORKER_HEARTBEAT_FILE?.trim()));
  const requireBackupReadiness = process.env.NODE_ENV === 'production';
  const requireDiskReadiness = process.env.NODE_ENV === 'production';
  const workerReadinessCheck =
    options.workerReadinessCheck ??
    (() =>
      readWorkerReadiness({
        maxOutboxAgeSeconds: outboxReadinessMaxAgeSeconds,
      }));
  const backupReadinessCheck =
    options.backupReadinessCheck ??
    (backupReadinessConfig ? () => readBackupReadiness(backupReadinessConfig) : undefined);
  const diskReadinessCheck =
    options.diskReadinessCheck ??
    (diskReadinessConfig ? () => readDiskReadiness(diskReadinessConfig) : undefined);
  const allowProxyTestOverrides = process.env.NODE_ENV !== 'production';
  const ipLimiter = rateLimitMiddleware({
    limiter,
    max: limits.subscribeMax,
    windowSeconds: limits.subscribeWindowSeconds,
    trustProxy: allowProxyTestOverrides
      ? (options.trustProxy ?? proxyTrustPolicy.trustProxy)
      : proxyTrustPolicy.trustProxy,
    proxySecretDigest: allowProxyTestOverrides
      ? (options.proxySecretDigest ?? proxyTrustPolicy.proxySecretDigest)
      : proxyTrustPolicy.proxySecretDigest,
    remoteAddress: options.remoteAddress,
  });

  const app = new Hono();

  // The provider webhook has a stricter exact raw-body ceiling. Register this
  // before the general API limiter so chunked bodies are rejected before
  // signature verification or JSON parsing.
  app.use(
    '/api/webhooks/resend',
    bodyLimit({
      maxSize: RESEND_WEBHOOK_MAX_BODY_BYTES,
      onError: () => {
        logWebhook('payload_too_large', 'warn');
        return errRes(
          apiError('payload_too_large', 'request body exceeds the 32 KiB limit'),
          API_ERROR_STATUS.payload_too_large,
        );
      },
    }),
  );

  // Pre-parse limit for every API body, including chunked bodies, raw webhooks,
  // ignored RFC 8058 bodies, and otherwise-unmatched body routes (AC-21).
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_JSON_BODY_BYTES,
      onError: () =>
        errRes(
          apiError('payload_too_large', 'request body exceeds the 64 KiB limit'),
          API_ERROR_STATUS.payload_too_large,
        ),
    }),
  );

  app.onError((error) => {
    console.error({
      event: 'unhandled_request_error',
      errorName: error instanceof Error ? error.constructor.name : 'unknown',
    });
    return errRes(
      apiError('internal_error', 'an unexpected error occurred'),
      API_ERROR_STATUS.internal_error,
    );
  });

  app.notFound(() => errRes(apiError('not_found', 'route not found'), API_ERROR_STATUS.not_found));

  // Liveness intentionally performs no dependency I/O.
  app.get('/api/health', (c) => c.json({ status: 'ok' }, 200));

  // Readiness aggregates only non-PII dependency/queue health.
  app.get('/api/ready', async (c) => {
    const checks: {
      database: 'ok' | 'unavailable';
      rateLimiter: 'ok' | 'unavailable';
      outbox: 'ok' | 'unavailable' | 'not-configured';
      backup?: 'ok' | 'unavailable';
      disk?: 'ok' | 'unavailable';
      worker?: 'ok' | 'unavailable';
    } = {
      database: 'ok',
      rateLimiter: 'ok',
      outbox: 'ok',
    };
    let outbox: ServerOutboxHealth | null = null;
    let backup: BackupReadinessResult['snapshot'] = null;
    let worker: WorkerReadinessResult['snapshot'] = null;

    if (repo.healthCheck) {
      try {
        await repo.healthCheck();
      } catch {
        checks.database = 'unavailable';
      }
    } else if (requireAggregateReadiness) {
      checks.database = 'unavailable';
    }
    try {
      await limiter.healthCheck();
    } catch {
      checks.rateLimiter = 'unavailable';
    }
    if (repo.getOutboxHealth) {
      try {
        outbox = await repo.getOutboxHealth();
        if (
          outbox.deadLetter > 0 ||
          (outbox.oldestQueuedAgeSeconds !== null &&
            outbox.oldestQueuedAgeSeconds > outboxReadinessMaxAgeSeconds)
        ) {
          checks.outbox = 'unavailable';
        }
      } catch {
        checks.outbox = 'unavailable';
      }
    } else {
      checks.outbox = 'not-configured';
    }

    if (backupReadinessCheck) {
      checks.backup = 'unavailable';
      try {
        const result = await backupReadinessCheck();
        backup = result.snapshot;
        if (result.ready) checks.backup = 'ok';
      } catch {
        // Fail closed without exposing filesystem/parser internals.
      }
    }

    if (diskReadinessCheck) {
      checks.disk = 'unavailable';
      try {
        const result = await diskReadinessCheck();
        if (result.ready) checks.disk = 'ok';
      } catch {
        // Fail closed without exposing filesystem internals.
      }
    }

    if (requireAggregateReadiness) {
      checks.worker = 'unavailable';
      try {
        const result = await workerReadinessCheck();
        worker = result.snapshot;
        if (result.ready) checks.worker = 'ok';
      } catch {
        // Fail closed without exposing filesystem/parser internals.
      }
    }

    const ready =
      checks.database === 'ok' &&
      checks.rateLimiter === 'ok' &&
      checks.outbox !== 'unavailable' &&
      checks.backup !== 'unavailable' &&
      checks.disk !== 'unavailable' &&
      (!requireAggregateReadiness ||
        (checks.outbox !== 'not-configured' && checks.worker === 'ok')) &&
      (!requireBackupReadiness || checks.backup === 'ok') &&
      (!requireDiskReadiness || checks.disk === 'ok');
    return c.json(
      {
        status: ready ? 'ready' : 'unavailable',
        checks,
        outbox,
        ...(backupReadinessCheck ? { backup } : {}),
        ...(requireAggregateReadiness ? { worker } : {}),
      },
      ready ? 200 : 503,
    );
  });

  app.post('/api/subscriptions', requireJsonMediaType, ipLimiter, async (c) => {
    const body = await parseJson(c);
    if (!body.ok) return body.response;
    const parsed = CreateSubscriptionRequestSchema.safeParse(body.value);
    if (!parsed.success) return errRes(zodToApiError(parsed.error), 400);

    const emailDecision = await checkEmailLimit(
      limiter,
      parsed.data.email,
      limits.emailMax,
      limits.emailWindowSeconds,
    );
    if (!emailDecision.allowed) {
      console.warn({ event: 'rate_limited', scope: 'email', route: 'subscribe' });
      return errRes(
        apiError('rate_limited', 'too many requests, please try again later'),
        API_ERROR_STATUS.rate_limited,
        { 'Retry-After': String(emailDecision.retryAfterSeconds) },
      );
    }

    if (!admissionAllowsCreate(admissionPolicy, c.req.raw.headers.get(PILOT_INVITE_CODE_HEADER))) {
      console.warn({ event: 'admission_denied' });
      return admissionUnavailableRes();
    }

    let result: Awaited<ReturnType<SubscriptionRepo['createSubscriber']>>;
    try {
      // The DB transaction creates Pending + Watches + Confirmation job.
      result = await repo.createSubscriber(parsed.data.email, parsed.data.classKeys);
    } catch (error) {
      if (isSubscriberCapacityError(error)) {
        console.warn({ event: 'admission_denied' });
        return admissionUnavailableRes();
      }
      return mapRepoError(error, capacityRetryAfterSeconds);
    }

    console.log({
      event: 'subscriber_created',
      subscriberId: result.id,
      watchCount: result.watches.length,
    });
    return jsonRes({ status: 'pending' }, 202);
  });

  // Static path must precede token routes.
  app.post('/api/subscriptions/resend', requireJsonMediaType, ipLimiter, async (c) => {
    const body = await parseJson(c);
    if (!body.ok) return body.response;
    const parsed = ResendManageLinkRequestSchema.safeParse(body.value);
    if (!parsed.success) return errRes(zodToApiError(parsed.error), 400);

    const emailDecision = await checkEmailLimit(
      limiter,
      parsed.data.email,
      limits.emailMax,
      limits.emailWindowSeconds,
    );
    if (!emailDecision.allowed) {
      console.warn({ event: 'rate_limited', scope: 'email', route: 'resend' });
      return errRes(
        apiError('rate_limited', 'too many requests, please try again later'),
        API_ERROR_STATUS.rate_limited,
        { 'Retry-After': String(emailDecision.retryAfterSeconds) },
      );
    }

    try {
      // One DB primitive performs the same lookup for known/unknown addresses
      // and transactionally queues the correct link kind when eligible.
      await repo.enqueueResendMailByEmail(parsed.data.email);
    } catch (error) {
      // Preserve the non-enumerating response on storage faults; log only the
      // class, never the recipient or driver message/params.
      console.error({
        event: 'resend_enqueue_failed',
        errorName: error instanceof Error ? error.constructor.name : 'unknown',
      });
      return recoveryInternalErrorRes();
    }
    console.log({ event: 'resend_processed' });
    return jsonRes({ status: 'sent' }, 202);
  });

  app.post('/api/webhooks/resend', async (c) => {
    if (RESEND_WEBHOOK_SIGNATURE_HEADERS.some((header) => !c.req.raw.headers.get(header))) {
      logWebhook('signature_missing', 'warn');
      return errRes(apiError('signature_invalid', 'invalid webhook signature'), 401);
    }

    const rawBody = await c.req.text();
    const verdict = verifyResendWebhook(c.req.raw.headers, rawBody);
    if (!verdict.ok) {
      logWebhook(signatureLogClassification(verdict.reason), 'warn');
      return errRes(apiError('signature_invalid', 'invalid webhook signature'), 401);
    }

    let value: unknown;
    try {
      value = JSON.parse(rawBody);
    } catch {
      logWebhook('payload_invalid', 'warn');
      return new Response(null, { status: 204 });
    }
    const parsed = ResendWebhookEventSchema.safeParse(value);
    if (!parsed.success) {
      logWebhook('payload_invalid', 'warn');
      return new Response(null, { status: 204 });
    }

    const suppressions = suppressionsFromResendEvent(parsed.data);
    if (suppressions.length === 0) {
      logWebhook('ignored');
      return new Response(null, { status: 204 });
    }
    for (const { email, reason } of suppressions) {
      try {
        await repo.suppressEmail(email, reason);
      } catch {
        logWebhook('suppression_persist_failed', 'error');
        return errRes(
          apiError('internal_error', 'suppression persistence failed'),
          API_ERROR_STATUS.internal_error,
        );
      }
    }
    logWebhook('suppressed');
    return new Response(null, { status: 204 });
  });

  app.get('/api/push/vapid-public-key', async (c) => {
    let operational = false;
    if (vapidPublicKey !== null) {
      try {
        operational = await (options.isPushOperational?.(vapidPublicKey) ?? true);
      } catch {
        console.warn({ event: 'push_readiness_check_failed' });
      }
    }
    return c.json({ publicKey: operational ? vapidPublicKey : null }, 200);
  });

  app.post('/api/subscriptions/:token/confirm', requireJsonMediaType, async (c) => {
    const resolved = resolveToken(c.req.param('token'));
    if (!resolved.ok) return resolved.res;
    const body = await parseJson(c);
    if (!body.ok) return body.response;
    const parsed = EmptyJsonRequestSchema.safeParse(body.value);
    if (!parsed.success) return errRes(zodToApiError(parsed.error), 400);

    let result: ConfirmSubscriberResult;
    try {
      result = await repo.confirmSubscriber(resolved.subscriberId);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    if (result === 'capacity_exceeded') {
      return capacityExceededRes(capacityRetryAfterSeconds);
    }
    if (result === 'already_confirmed') {
      console.log({
        event: 'subscription_confirm_noop',
        subscriberId: resolved.subscriberId,
      });
      return jsonRes({ status: 'confirmed' }, 200);
    }
    console.log({ event: 'subscription_confirmed', subscriberId: resolved.subscriberId });
    return jsonRes({ status: 'confirmed' }, 200);
  });

  app.post('/api/subscriptions/:token/push', requireJsonMediaType, ipLimiter, async (c) => {
    const resolved = resolveToken(c.req.param('token'));
    if (!resolved.ok) return resolved.res;
    const body = await parseJson(c);
    if (!body.ok) return body.response;
    const parsed = EnablePushRequestSchema.safeParse(body.value);
    if (!parsed.success) return errRes(zodToApiError(parsed.error), 400);
    if (!hasValidPushCurvePoint(parsed.data.keys)) {
      return errRes(apiError('validation_error', 'invalid browser push key'), 400);
    }

    let subscriber: SubscriberRecord | null;
    try {
      subscriber = await repo.getSubscriberById(resolved.subscriberId);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    if (!subscriber) return errRes(apiError('not_found', 'subscriber not found'), 404);
    if (!subscriber.confirmed) {
      return errRes(
        apiError('conflict', 'confirm your subscription before enabling push'),
        API_ERROR_STATUS.conflict,
      );
    }

    try {
      await repo.upsertPushSubscription(
        resolved.subscriberId,
        parsed.data.endpoint,
        parsed.data.keys,
      );
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    console.log({ event: 'push_enabled', subscriberId: resolved.subscriberId });
    return jsonRes({ status: 'enabled' }, 201);
  });

  app.delete('/api/subscriptions/:token/push', requireJsonMediaType, async (c) => {
    const resolved = resolveToken(c.req.param('token'));
    if (!resolved.ok) return resolved.res;
    const body = await parseJson(c);
    if (!body.ok) return body.response;
    const parsed = DisablePushRequestSchema.safeParse(body.value);
    if (!parsed.success) return errRes(zodToApiError(parsed.error), 400);

    let subscriber: SubscriberRecord | null;
    try {
      subscriber = await repo.getSubscriberById(resolved.subscriberId);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    if (!subscriber) return errRes(apiError('not_found', 'subscriber not found'), 404);

    try {
      await repo.deletePushSubscriptionForSubscriber(resolved.subscriberId, parsed.data.endpoint);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    console.log({ event: 'push_disabled', subscriberId: resolved.subscriberId });
    return new Response(null, { status: 204 });
  });

  app.get('/api/subscriptions/:token', async (c) => {
    const resolved = resolveToken(c.req.param('token'));
    if (!resolved.ok) return resolved.res;
    let subscriber: SubscriberRecord | null;
    try {
      subscriber = await repo.getSubscriberById(resolved.subscriberId);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    if (!subscriber) return errRes(apiError('not_found', 'subscriber not found'), 404);

    console.log({
      event: 'subscription_fetched',
      subscriberId: subscriber.id,
      watchCount: subscriber.watches.length,
    });
    return c.json(
      {
        email: subscriber.email,
        confirmed: subscriber.confirmed,
        watches: subscriber.watches,
        watchFreshness: subscriber.watchFreshness,
      },
      200,
    );
  });

  app.post('/api/subscriptions/:token/watches', requireJsonMediaType, async (c) => {
    const resolved = resolveToken(c.req.param('token'));
    if (!resolved.ok) return resolved.res;
    const body = await parseJson(c);
    if (!body.ok) return body.response;
    const parsed = AddWatchRequestSchema.safeParse(body.value);
    if (!parsed.success) return errRes(zodToApiError(parsed.error), 400);

    let subscriber: SubscriberRecord | null;
    try {
      subscriber = await repo.getSubscriberById(resolved.subscriberId);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    if (!subscriber) return errRes(apiError('not_found', 'subscriber not found'), 404);

    let result: Awaited<ReturnType<SubscriptionRepo['addWatch']>>;
    try {
      result = await repo.addWatch(resolved.subscriberId, parsed.data.classKey);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    console.log({
      event: 'watch_added',
      subscriberId: resolved.subscriberId,
      watchCount: result.watches.length,
    });
    return c.json({ watches: result.watches, watchFreshness: result.watchFreshness }, 200);
  });

  app.delete('/api/subscriptions/:token/watches/:classKey', async (c) => {
    const rawToken = c.req.param('token');
    const parsed = RemoveWatchParamsSchema.safeParse({
      token: rawToken,
      classKey: c.req.param('classKey'),
    });
    if (!parsed.success) {
      if (parsed.error.issues.some((issue) => issue.path[0] === 'token')) {
        return errRes(apiError('token_invalid', 'invalid or expired token'), 401);
      }
      return errRes(zodToApiError(parsed.error), 400);
    }
    const resolved = resolveToken(rawToken);
    if (!resolved.ok) return resolved.res;

    let subscriber: SubscriberRecord | null;
    try {
      subscriber = await repo.getSubscriberById(resolved.subscriberId);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    if (!subscriber) return errRes(apiError('not_found', 'subscriber not found'), 404);

    try {
      await repo.removeWatch(resolved.subscriberId, parsed.data.classKey);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    console.log({ event: 'watch_removed', subscriberId: resolved.subscriberId });
    return new Response(null, { status: 204 });
  });

  // RFC 8058 body is intentionally ignored, but the global body limit still
  // consumes/rejects it before this handler.
  app.post('/api/subscriptions/:token/unsubscribe', async (c) => {
    const resolved = resolveToken(c.req.param('token'));
    if (!resolved.ok) return resolved.res;
    let subscriber: SubscriberRecord | null;
    try {
      subscriber = await repo.getSubscriberById(resolved.subscriberId);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    if (!subscriber) return errRes(apiError('not_found', 'subscriber not found'), 404);
    try {
      await repo.deleteSubscriber(resolved.subscriberId);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    console.log({
      event: 'subscriber_unsubscribed_oneclick',
      subscriberId: resolved.subscriberId,
    });
    return new Response(null, { status: 204 });
  });

  app.delete('/api/subscriptions/:token', async (c) => {
    const rawToken = c.req.param('token');
    if (!TokenParamsSchema.safeParse({ token: rawToken }).success) {
      return errRes(apiError('token_invalid', 'invalid or expired token'), 401);
    }
    const resolved = resolveToken(rawToken);
    if (!resolved.ok) return resolved.res;

    let subscriber: SubscriberRecord | null;
    try {
      subscriber = await repo.getSubscriberById(resolved.subscriberId);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    if (!subscriber) return errRes(apiError('not_found', 'subscriber not found'), 404);
    try {
      await repo.deleteSubscriber(resolved.subscriberId);
    } catch (error) {
      return mapRepoError(error, capacityRetryAfterSeconds);
    }
    console.log({ event: 'subscriber_deleted', subscriberId: resolved.subscriberId });
    return new Response(null, { status: 204 });
  });

  return app;
}
