/**
 * src/worker/types.ts
 *
 * Shared types for the worker lane. These are the interfaces the poller and
 * the test-engineer depend on. Keeping them in a separate file means neither
 * the repo adapter nor the poller file imports the other transitively.
 *
 * Lane: src/worker/** — owned by worker-engineer.
 */

import type { ClassKey } from '../shared/class-key';
import type { NotifyReason, SeatStatus } from '../shared/seat-state';
import type { MailDispatchJob } from '../notify';
import type {
  DeadLetterIncidentSurfaceClaim,
  MailClaimBatch,
  MailDeferDisposition,
  RecordParserBrokenResult,
} from '../db';

export interface AlertDeliveryInput {
  subscriberId: string;
  classKey: ClassKey;
  openedAt: string;
  reason: NotifyReason;
  openSeats: number;
}

export interface PendingAlertDelivery extends AlertDeliveryInput {
  /** Joined at retry time; PII, never log. */
  email: string;
  createdAt: Date;
}

/**
 * Nullable dashboard observations persisted with every successful page parse.
 * These keys are required at the worker/DB boundary so an omitted producer
 * cannot silently erase or retain part of the authoritative snapshot.
 */
export interface PersistedDashboardObservations {
  displayName: string | null;
  lastEnrolled: number | null;
  lastCapacity: number | null;
  lastWaitlisted: number | null;
  lastWaitlistMax: number | null;
}

export interface OpeningTransitionInput {
  classKey: ClassKey;
  previousStateVersion: number;
  openedAt: string;
  reason: NotifyReason;
  openSeats: number;
  nextState: PersistedDashboardObservations & {
    lastStatus: SeatStatus;
    lastOpenSeats: number;
    lastWaitlistOpen: boolean;
    sourceFreshUntil?: Date;
  };
}

export interface OpeningMailCommitResult {
  transitioned: boolean;
  enqueued: number;
}

export interface MailCompletionInput {
  id: string;
  claimToken: string;
  providerMessageId?: string;
  providerAcceptedAt?: Date;
}

export interface MailDeferInput {
  id: string;
  claimToken: string;
  availableAt: Date;
  errorCode: string;
}

export interface RetentionSweepResult {
  pendingSubscribers: number;
  terminalMailJobs: number;
  legacyAlertDeliveries: number;
  retiredWatches: number;
  orphanedClassStates: number;
  expiredMailJobs: number;
}

export interface MailOutboxHealth {
  queued: number;
  processing: number;
  deadLetter: number;
  oldestQueuedAt: Date | null;
}

// ---------------------------------------------------------------------------
// WorkerRepo
// ---------------------------------------------------------------------------

/**
 * The db operations the poller needs, pre-bound to a specific db connection.
 * No `db` param — the binding is done at construction time in
 * `createWorkerRepo`. Tests inject a fake that satisfies this interface
 * without touching the real db.
 */
export interface WorkerRepo {
  /**
   * All distinct class keys currently watched by at least one subscriber.
   * The poller iterates this once per cycle to build the unique-class fetch
   * queue (FR-3: ONE fetch per unique class per interval). Returns only LIVE
   * (un-retired) watches, so a class-gone-retired class is never re-fetched
   * (FR-13 / AC-14).
   */
  getDistinctWatchedClassKeys(): Promise<ClassKey[]>;

  /** Database-clock boundary captured before class fetches start. */
  /** Exact PostgreSQL timestamptz text; do not round through JavaScript Date. */
  getPollCycleCutoff(): Promise<string>;

  /**
   * CONFIRMED subscribers with a LIVE watch on a given class. Used for fan-out
   * after a genuine opening is detected (FR-4 / FR-9 / AC-9). Returns only
   * {id, email} — the minimum PII surface needed by the notifier. Never log the
   * emails (AC-8).
   */
  getSubscribersWatching(classKey: ClassKey): Promise<Array<{ id: string; email: string }>>;

  /** Insert the durable idempotency row before attempting an alert send. */
  claimAlertDelivery(delivery: AlertDeliveryInput): Promise<'claimed' | 'pending' | 'sent'>;

  /** Atomically persist an opening transition and claim its full fan-out. */
  claimOpeningDeliveries(opening: OpeningTransitionInput): Promise<PendingAlertDelivery[]>;

  /** Oldest outstanding sends; retried at the start of later cycles. */
  listPendingAlertDeliveries(): Promise<PendingAlertDelivery[]>;

  /** Refresh subscriber/watch eligibility immediately before provider egress. */
  getEligibleAlertDelivery?(
    key: Pick<AlertDeliveryInput, 'subscriberId' | 'classKey' | 'openedAt'>,
  ): Promise<PendingAlertDelivery | undefined>;

  /** Make an ineligible pending row terminal so it cannot monopolize retries. */
  cancelAlertDelivery?(
    key: Pick<AlertDeliveryInput, 'subscriberId' | 'classKey' | 'openedAt'>,
  ): Promise<boolean>;

  /** Defer a provider failure with per-delivery exponential backoff. */
  deferAlertDelivery?(
    key: Pick<AlertDeliveryInput, 'subscriberId' | 'classKey' | 'openedAt'>,
  ): Promise<boolean>;

  /** Stamp a claimed row only after dispatch reports success. */
  markAlertDeliverySent(
    key: Pick<AlertDeliveryInput, 'subscriberId' | 'classKey' | 'openedAt'>,
  ): Promise<boolean>;

  /**
   * Retire EVERY live watch on a class (class-gone, FR-13 / D8 / AC-14). The
   * worker calls this on a `class-gone` ParseResult: the class is no longer
   * polled (it drops out of getDistinctWatchedClassKeys), no longer fanned out,
   * and no longer listed in the manage view. Idempotent — re-running it does not
   * re-stamp already-retired rows. Returns the count of watches retired this
   * call (count only — never log the rows / PII). Does NOT page the operator and
   * does NOT notify subscribers; `class_state` is untouched.
   */
  retireWatchesForClass(classKey: ClassKey, activatedThrough: string): Promise<number>;

  /**
   * Last-persisted state for a class. Returns `undefined` on first sighting
   * (the poller establishes a baseline without notifying on that first poll).
   */
  getClassState(classKey: ClassKey): Promise<
    | (PersistedDashboardObservations & {
        classKey: ClassKey;
        lastStatus: SeatStatus;
        lastOpenSeats: number;
        lastWaitlistOpen: boolean;
        stateVersion: number;
        /** v0.4 source-visible freshness deadline. Absent only in legacy fakes. */
        sourceFreshUntil?: Date;
        updatedAt: Date;
      })
    | undefined
  >;

  /**
   * Persist the new state for a class after a successful parse. MUST NOT be
   * called on a parser-broke result (FR-6 / AC-5).
   */
  upsertClassState(
    state: PersistedDashboardObservations & {
      classKey: ClassKey;
      lastStatus: SeatStatus;
      lastOpenSeats: number;
      lastWaitlistOpen: boolean;
      sourceFreshUntil?: Date;
    },
  ): Promise<void>;
}

/**
 * Runtime-only v0.4 DB surface. It is separate from WorkerRepo so the legacy
 * deterministic cycle and its small fakes remain source-compatible while the
 * production worker uses the durable mail queue.
 */
export interface DurableWorkerRepo {
  commitOpeningAndEnqueueMail(opening: OpeningTransitionInput): Promise<OpeningMailCommitResult>;
  enqueueOperatorMail(input: { classKey?: ClassKey; detail: string }): Promise<string>;
  /**
   * Atomically open one parser-broke episode and enqueue its sole Operator
   * mail. Repeated observations remain no-ops until a successful parse records
   * recovery.
   */
  recordParserBroken(input: {
    classKey: ClassKey;
    detail: string;
  }): Promise<RecordParserBrokenResult>;
  /** Arm a future parser alert only after a successful SeatState parse. */
  recordParserRecovery(classKey: ClassKey): Promise<boolean>;
  /** Claim work plus jobs terminalized at the retry horizon in the same transaction. */
  claimMailBatch(options?: { limit?: number; leaseSeconds?: number }): Promise<MailClaimBatch>;
  /** Compatibility surface for legacy callers that need only the claimed jobs. */
  claimMailJobs(options?: { limit?: number; leaseSeconds?: number }): Promise<MailDispatchJob[]>;
  completeMailJob(input: MailCompletionInput): Promise<boolean>;
  cancelClaimedMailJob(input: {
    id: string;
    claimToken: string;
    reason: 'suppressed';
  }): Promise<boolean>;
  deferMailJob(input: MailDeferInput): Promise<MailDeferDisposition>;
  deadLetterMailJob(input: { id: string; claimToken: string; errorCode: string }): Promise<boolean>;
  /**
   * Read a bounded set of unsurfaced durable incidents. External publication
   * uses each returned stable idempotency key and never creates mail-outbox
   * work.
   */
  claimDeadLetterIncidentsForSurface(options?: {
    limit?: number;
  }): Promise<DeadLetterIncidentSurfaceClaim[]>;
  /** Stamp an incident only after the out-of-band provider accepts it. */
  markDeadLetterIncidentSurfaced(input: { id: string; surfacedAt?: Date }): Promise<boolean>;
  expireMailOutboxAlerts(): Promise<number>;
  getMailOutboxHealth(): Promise<MailOutboxHealth>;
  sweepRetention(now?: Date): Promise<RetentionSweepResult>;
}

export type RuntimeWorkerRepo = WorkerRepo & DurableWorkerRepo;

// ---------------------------------------------------------------------------
// CycleSummary
// ---------------------------------------------------------------------------

/**
 * What one poll cycle did. Returned by `runPollCycle` so tests and the
 * scheduler can assert on outcomes without inspecting internal state.
 *
 * PII rule: this object must never carry subscriber emails or full watch
 * lists. `notified` and `suppressed` are counts; `parserBroke` carries only
 * class keys (not PII).
 */
export interface CycleSummary {
  /** Number of unique classes fetched this cycle (0 when kill-switch active). */
  fetched: number;

  /** Class keys for which the parser-broke signal was returned. */
  parserBroke: ClassKey[];

  /**
   * Class keys whose page was gone (404 / not-found) this cycle — every live
   * watch on them was retired (FR-13 / AC-14). Observability counter; no
   * operator page, no subscriber alert. Optional so existing callers/tests that
   * predate class-gone are unaffected.
   */
  classGone?: ClassKey[];

  /**
   * Debounce keys for which an operator alert ACTUALLY fired this cycle (after
   * once-per-episode debounce, FR-14 / AC-15). A genuine per-class break keys on
   * the classKey; a host-level robots outage collapses to one synthetic key.
   * Observability counter; optional for back-compat.
   */
  operatorAlerted?: string[];

  /**
   * Total subscriber notifications dispatched this cycle (across all classes
   * and all subscribers). Counts only events where dispatch() returned
   * { sent: true }.
   */
  notified: number;

  /**
   * Notifications suppressed by the notifier's idempotency DEDUPE — dispatch()
   * returned { sent:false, suppressed:false } because this exact
   * (subscriberId, classKey, openedAt) was already delivered (FR-4/FR-5). Under
   * correct worker-level transition detection this should be 0 in normal
   * operation; a non-zero value indicates a bug in transition detection or a
   * replay. This is the §6 "dedupe suppressions" metric.
   *
   * NOTE: this counter is DISTINCT from `addressSuppressed` — the two §6 metrics
   * (dedupe suppressions vs suppressed-address skips) must not be conflated.
   */
  suppressed: number;

  /**
   * Subscriber sends skipped because the notifier withheld to a SUPPRESSED
   * address — dispatch() returned { sent:false, suppressed:true } (FR-12,
   * hard-bounce/complaint hygiene). This is the §6 "suppressed-address skips"
   * metric, kept separate from `suppressed` (dedupe). Optional so callers/tests
   * that predate the split are unaffected.
   */
  addressSuppressed?: number;

  /** v0.4 cache-aware source and durable-outbox counters (all PII-free). */
  sourceRequests?: number;
  sourceNotModified?: number;
  sourceDeferred?: number;
  sourceFailures?: number;
  mailClaimed?: number;
  mailSent?: number;
  mailDeferred?: number;
  mailCancelledExpired?: number;
  mailDeadLettered?: number;
  mailClaimFenceLost?: number;
  retentionPurged?: number;
  sourceStaleCount?: number;
  outboxQueued?: number;
  outboxProcessing?: number;
  outboxDeadLetter?: number;
  outboxOldestQueuedAgeMs?: number | null;
  nextSourceCheckAt?: string | null;
  /** True when KILL_SWITCH or the durable FR-7 safety stop disabled source egress. */
  sourceDisabled?: boolean;
  healthy?: boolean;
}
