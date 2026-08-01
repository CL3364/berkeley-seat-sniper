import type { ClassKey } from '../shared/class-key';
import type { NotifyEvent, NotifyReason, PushAlertPayload } from '../shared/seat-state';

/**
 * The pinned outbox kinds (spec §4). Every entry the notifier records carries
 * exactly one of these. Subscriber-facing kinds (`alert | confirmation |
 * manage-link`) pass the suppression gate (FR-12) before they are sent; the
 * `operator` kind is internal and exempt.
 *
 * NOTE (terminology, v0.3): the seat-open subscriber alert is kind `'alert'`
 * (was `'subscriber'` in v0.1/v0.2). Tests extract confirm/manage links from
 * confirmation/manage-link bodies by regex, so those bodies render the absolute
 * URL on its own line (spec §4 pinned link formats).
 */
export const OUTBOX_KINDS = ['alert', 'confirmation', 'manage-link', 'operator'] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/**
 * An entry in the outbox — models a single sent message. The `to` field holds
 * the delivery address (present because the outbox models the sent mail, not a
 * log line; log lines MUST NOT print it). Tests inspect this shape.
 */
export interface OutboxEntry {
  /** Pinned kind (spec §4): alert | confirmation | manage-link | operator. */
  kind: OutboxKind;
  /** Delivery address — present in outbox only, never in log lines. */
  to: string;
  subject: string;
  body: string;
  /** ISO-8601 UTC timestamp of when this entry was recorded. */
  sentAt: string;
  /** Durable provider idempotency key for this outbox job. */
  idempotencyKey?: string;
  /** For `operator` entries: free-form detail from the alertOperator call. */
  detail?: string;
}

/**
 * Extra RFC-8058 list-management headers attached to subscriber-facing mail
 * (alert, confirmation, manage-link). The notifier sets BOTH on every such
 * message:
 *   List-Unsubscribe:      <https://app/api/subscriptions/<token>/unsubscribe>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 * Operator mail carries no such headers (it is internal, not bulk mail).
 */
export interface MailHeaders {
  'List-Unsubscribe'?: string;
  'List-Unsubscribe-Post'?: string;
}

/**
 * The interface every mail-transport adapter must satisfy. Transports never
 * invent or alter idempotency keys: the durable outbox supplies one per job.
 */
export interface Transport {
  /**
   * Optional brand. ONLY the no-op transport carries `kind: 'noop'`
   * ({@link createNoopTransport} stamps it); real transports (Resend/SMTP)
   * leave it unset. This is additive — real transports need no change to
   * satisfy the interface.
   *
   * The env-gated `NOOP_OUTBOX_FILE` sink (index.ts) keys off THIS brand, not
   * merely "a transport was injected", so an explicitly injected REAL transport
   * can never tee subscriber emails + tokens to disk (spec v0.3.1: the sink is
   * honored ONLY when the transport IS the noop transport). A test fake that
   * wants to exercise the file sink must deliberately set `kind: 'noop'` on the
   * object it returns — mimicking the noop's SHAPE is not enough.
   */
  readonly kind?: 'noop';
  /**
   * Send a single message. Implementations may retry internally but MUST
   * surface a failure rather than swallowing it — the notifier layer logs the
   * error and bubbles it to the worker so it can be counted as a failure, not
   * silently dropped.
   */
  send(message: TransportMessage): Promise<ProviderOutcome | void>;
}

/** Minimal wire shape passed to a transport. */
export interface TransportMessage {
  to: string;
  from: string;
  subject: string;
  body: string;
  /**
   * Stable durable-job key for provider-side deduplication. Every production
   * outbox kind sets it, and every retry reuses it with an identical payload.
   */
  idempotencyKey?: string;
  /**
   * Optional extra mail headers (RFC 8058 List-Unsubscribe family). Present on
   * subscriber-facing mail; absent on operator mail. A transport that cannot
   * set custom headers may ignore them.
   */
  headers?: MailHeaders;
}

/** Provider accepted the request. The durable outbox remains the source of truth. */
export interface ProviderSuccess {
  status: 'success';
  /** Provider identifier, when returned. Never contains a recipient address. */
  providerMessageId?: string;
  acceptedAt: Date;
}

/** A transient provider/network failure that should use normal backoff. */
export interface ProviderRetryable {
  status: 'retryable';
  /** Stable bounded classification, never a raw provider response or exception. */
  errorCode: string;
}

/** Explicit provider throttling. The worker must honor `retryAfterMs`. */
export interface ProviderRateLimited {
  status: 'rate-limited';
  errorCode: 'provider_rate_limited';
  retryAfterMs: number;
}

/** A request the provider will not accept without changing it. */
export interface ProviderPermanent {
  status: 'permanent';
  /** Stable bounded classification, normally `provider_http_<status>`. */
  errorCode: string;
}

/** Typed outcome returned by every production mail-provider attempt. */
export type ProviderOutcome =
  | ProviderSuccess
  | ProviderRetryable
  | ProviderRateLimited
  | ProviderPermanent;

/**
 * Structural handoff from `db.claimMailJobs`. Recipient email is joined only
 * for the claim and tokens are deliberately absent; the dispatcher mints them
 * immediately before rendering.
 */
export interface MailDispatchJob {
  id: string;
  claimToken: string;
  kind: OutboxKind;
  subscriberId: string | null;
  email: string | null;
  subscriberConfirmed: boolean | null;
  classKey: ClassKey | null;
  openedAt: Date | null;
  reason: NotifyReason | null;
  attempts: number;
  expiresAt: Date | null;
  providerIdempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** Suppression is a terminal, non-error consumption of the claimed job. */
export interface MailDispatchSuppressed {
  status: 'suppressed';
}

/** Every email outcome may carry independently-started best-effort push work. */
export type MailDispatchWithPush<T> = T & {
  pushCompletion?: Promise<number>;
};

/**
 * Result consumed by the outbox worker:
 * - success → claim-fenced complete
 * - suppressed → claim-fenced cancel with reason `suppressed`
 * - retryable/rate-limited → defer
 * - permanent → dead-letter
 */
export type MailDispatchResult =
  | MailDispatchWithPush<ProviderSuccess>
  | MailDispatchWithPush<MailDispatchSuppressed>
  | MailDispatchWithPush<ProviderRetryable>
  | MailDispatchWithPush<ProviderRateLimited>
  | MailDispatchWithPush<ProviderPermanent>;

export interface MailDispatchBatchItem {
  jobId: string;
  result: MailDispatchResult;
}

/**
 * Durable incident handed to the out-of-band publisher. It is intentionally
 * recipient-free: the referenced mail job may contain subscriber PII, but the
 * operational alert needs only opaque ids and bounded classifications.
 */
export interface DeadLetterIncidentSurface {
  id: string;
  mailJobId: string;
  idempotencyKey: string;
  mailKind: OutboxKind;
  terminalReason: string | null;
  lastErrorCode: string | null;
  openedAt: Date;
}

/** Durable mail-outbox rendering/provider boundary used by the worker. */
export interface MailDispatcher {
  dispatch(job: MailDispatchJob): Promise<MailDispatchResult>;
  /**
   * Dispatch claimed jobs and return one aligned result per input. Each email
   * uses its own durable provider key; provider batching is deliberately not
   * used because transient claim membership is not a stable idempotency unit.
   */
  dispatchBatch(jobs: readonly MailDispatchJob[]): Promise<MailDispatchBatchItem[]>;
  /**
   * Publish one dead-letter incident directly to the Operator channel. This is
   * deliberately outside `mail_outbox`, including when the failed job itself
   * was `operator`, so it can never create a recursive mail-job chain.
   *
   * Optional only for compatibility with small injected test doubles. The
   * production dispatcher always implements it.
   */
  publishDeadLetterIncident?(incident: DeadLetterIncidentSurface): Promise<ProviderOutcome>;
  /** Populated only for the branded noop transport (FR-8). */
  readonly outbox: OutboxEntry[];
}

/**
 * Token minting dependency. `issuedAt` is the durable Alert `openedAt` or other
 * job `createdAt`, so every retry reproduces byte-identical links and headers.
 * A one-argument test minter remains assignable and may ignore the timestamp.
 */
export type TokenMinter = (subscriberId: string, issuedAt: Date) => string | Promise<string>;

/**
 * Result of pushing ONE alert to ONE browser. The notifier uses `gone` to drive
 * the 404/410 endpoint cleanup (spec §5 / FR-15) and `ok` to count successes.
 * Never carries the endpoint or keys — those are delivery credentials.
 */
export interface PushSendResult {
  /** true when the push service accepted the message. */
  ok: boolean;
  /** true when the service reported the subscription is gone (404/410). */
  gone: boolean;
}

/**
 * Push-transport abstraction (FR-15 / D10). Real impl wraps `web-push`; the fake
 * records `(endpoint, payload)` pairs for tests. ALERTS-ONLY by contract: the
 * payload is a {@link PushAlertPayload} and nothing else (no token, no links).
 *
 * `enabled` reflects whether VAPID keys are configured. When false, push is
 * silently disabled (email-only) — legal config per the spec, unlike a missing
 * OPERATOR_EMAIL.
 */
export interface PushTransport {
  /** Whether VAPID is configured. When false, `send` is a no-op returning ok:false, gone:false. */
  readonly enabled: boolean;
  /**
   * Deliver one alert payload to one browser. MUST NOT throw for a normal
   * delivery failure (including a gone subscription) — it returns a result the
   * notifier inspects. It may throw only for a programmer error (e.g. an
   * unserializable payload); the notifier isolates that too so push never
   * blocks the email path.
   */
  send(target: PushTarget, payload: PushAlertPayload): Promise<PushSendResult>;
}

/** One registered browser to push to. Delivery credentials — never logged. */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * The push subscriptions the notifier should push an alert to, plus the cleanup
 * hook for gone (404/410) endpoints. Injected so the notify lane never imports
 * the db client directly (it owns no db handle). The worker/backend wires these
 * from the repo (`listPushSubscriptions` / `deletePushSubscription`).
 */
export interface PushDeps {
  /** List a subscriber's registered browsers (repo.listPushSubscriptions). */
  listPushSubscriptions(subscriberId: string): Promise<PushTarget[]>;
  /**
   * Delete one browser after a 404/410 only if the subscriber and credential
   * snapshot still match. This prevents a stale response from deleting an
   * endpoint that was reassigned or refreshed while the request was in flight.
   */
  deletePushSubscriptionIfMatches(subscriberId: string, target: PushTarget): Promise<void>;
  /** The push transport (real web-push impl, or a fake in tests). */
  transport: PushTransport;
}

/**
 * Suppression checker (FR-12). Injected so the notify lane never imports the db
 * client. The worker/backend wires this from the repo's `isSuppressed`. Returns
 * true when the address must receive NOTHING (alert, confirmation, manage-link).
 */
export type SuppressionChecker = (email: string) => Promise<boolean>;

/**
 * The public API surface of a Notifier instance. The backend dispatches
 * confirmation + manage-link mail; the worker dispatches alerts + operator
 * alerts. `outbox` is populated only by the branded noop transport; real
 * transports retain no recipient, token, or body snapshots in memory.
 */
export interface Notifier {
  /**
   * Deliver a seat-open Alert to one subscriber (kind `'alert'`), then push the
   * same opening to each of that subscriber's registered browsers (FR-15).
   *
   * Idempotent keyed on `(subscriberId, classKey, openedAt)` — a repeat call
   * with the same event is a no-op. Suppression-gated (FR-12): a suppressed
   * address receives nothing and the outbox records nothing for it. Push runs
   * AFTER the email and is fully isolated — a push failure never blocks or
   * fails the email path. PII rule: never log event.email; log subscriberId +
   * counts.
   *
   * `manageToken` is the subscriber's signed manage token, supplied by the
   * worker at fan-out (the shared `NotifyEvent` carries no token by design — it
   * is bundled client-side, §4). When present, the alert email renders the
   * manage/unsubscribe footer link AND the RFC 8058 List-Unsubscribe headers
   * (spec §6). When omitted, the alert is still delivered but without those —
   * the email channel still works; the one-click header is best-effort on the
   * token's presence. The token is a secret — NEVER logged.
   */
  dispatch(event: NotifyEvent, manageToken?: string): Promise<DispatchResult>;

  /**
   * Send a CONFIRMATION email carrying the confirm link
   * `${APP_BASE_URL}/?confirm=<token>` (kind `'confirmation'`). Used on
   * subscribe and on resend-while-Pending. Suppression-gated (FR-12).
   * The token is PII-adjacent — never logged.
   */
  sendConfirmation(input: ConfirmationInput): Promise<SendResult>;

  /**
   * Send a MANAGE-LINK email carrying the manage link
   * `${APP_BASE_URL}/?token=<token>` (kind `'manage-link'`). Used on
   * resend-while-Confirmed. Suppression-gated (FR-12). Token never logged.
   */
  sendManageLink(input: ManageLinkInput): Promise<SendResult>;

  /**
   * Send a distinct operator-facing alert for a parser-broke incident
   * (kind `'operator'`). Never subscriber-facing, EXEMPT from suppression
   * (FR-12). Transport failures are re-thrown so the worker does not advance
   * the episode debounce until delivery succeeds.
   */
  alertOperator(classKey: string, detail: string): Promise<void>;

  /** Inspect delivered messages — populated only by the branded noop transport. */
  readonly outbox: OutboxEntry[];
}

/** Input to {@link Notifier.sendConfirmation}. */
export interface ConfirmationInput {
  /** Opaque subscriber id — for logs (never the email). */
  subscriberId: string;
  /** Delivery address. PII — never logged. */
  email: string;
  /** The signed manage token (also the confirm token, spec §4). Never logged. */
  token: string;
}

/** Input to {@link Notifier.sendManageLink}. */
export interface ManageLinkInput {
  subscriberId: string;
  email: string;
  token: string;
}

/** Result returned by dispatch so the worker can track metrics. */
export interface DispatchResult {
  /** true = email sent; false = suppressed by idempotency dedupe OR address suppression. */
  sent: boolean;
  /** Opaque key used for dedupe (useful for test assertions). */
  idempotencyKey: string;
  /** true when the send was withheld because the address is suppressed (FR-12). */
  suppressed: boolean;
  /**
   * Pushes completed before the email result resolved. Push is deliberately
   * decoupled from email, so successful email dispatch currently reports 0;
   * await `pushCompletion` for the eventual count.
   */
  pushed: number;
  /**
   * Best-effort push completion. Email delivery resolves `dispatch` first so a
   * hanging push can never occupy an email fan-out slot; callers that need the
   * eventual push count (tests/metrics) may await this promise separately.
   */
  pushCompletion?: Promise<number>;
}

/** Result returned by the confirmation / manage-link senders. */
export interface SendResult {
  /** true = email sent; false = withheld because the address is suppressed (FR-12). */
  sent: boolean;
  /** true when withheld due to suppression (lets callers do constant work, FR-10). */
  suppressed: boolean;
}
