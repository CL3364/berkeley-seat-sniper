import {
  and,
  asc,
  count,
  countDistinct,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { MAX_WATCHES_PER_SUBSCRIBER } from '../shared/api';
import type { PushKeys, SuppressionReason } from '../shared/api';
import type { ClassKey } from '../shared/class-key';
import { ClassKeySchema } from '../shared/class-key';
import { EmailSchema, SubscriberEmailSchema } from '../shared/email';
import { MAX_OBSERVED_COUNT, type NotifyReason, type SeatStatus } from '../shared/seat-state';
import type { Db } from './client';
import {
  alertDeliveries,
  classState,
  deadLetterIncidents,
  mailOutbox,
  parserHealth,
  pushSubscriptions,
  subscribers,
  suppressions,
  watches,
} from './schema';
import type { DeadLetterIncidentState, MailOutboxKind, MailOutboxTerminalReason } from './schema';

// ---------------------------------------------------------------------------
// Typed error sentinels
// ---------------------------------------------------------------------------

/**
 * Thrown by createSubscriberWithWatches when the email is already registered.
 * The backend catches this and returns ApiErrorCode 'conflict' (409).
 *
 * Security rationale: never upsert or return a manage token for a pre-existing
 * subscription via an unauthenticated create request — that would let anyone
 * who types a victim's email take over their watches or unsubscribe them.
 * Insert-only semantics are required (AC-2b / spec §4 conflict error).
 */
export class DuplicateSubscriberError extends Error {
  constructor() {
    super('subscriber email already registered');
    this.name = 'DuplicateSubscriberError';
  }
}

/**
 * Thrown by addWatch when the (subscriber_id, class_key) unique constraint
 * fires. The backend catches this and maps it to ApiErrorCode 'conflict' (409).
 * Never catch and swallow this — surface it to the caller.
 */
export class DuplicateWatchError extends Error {
  readonly subscriberId: string;
  readonly classKey: ClassKey;

  constructor(subscriberId: string, classKey: ClassKey) {
    super('watch already exists');
    this.name = 'DuplicateWatchError';
    this.subscriberId = subscriberId;
    this.classKey = classKey;
  }
}

/** Thrown when adding/reviving a watch would exceed the contract's live cap. */
export class WatchLimitError extends Error {
  readonly subscriberId: string | undefined;

  constructor(subscriberId?: string) {
    super('watch limit reached');
    this.name = 'WatchLimitError';
    this.subscriberId = subscriberId;
  }
}

/** Thrown when a locked subscriber row vanished before a dependent write. */
export class SubscriberNotFoundError extends Error {
  readonly subscriberId: string;

  constructor(subscriberId: string) {
    super('subscriber not found');
    this.name = 'SubscriberNotFoundError';
    this.subscriberId = subscriberId;
  }
}

// Compatibility re-export: the authoritative value lives in the shared
// contract so the database, server, and dashboard cannot drift.
export { MAX_WATCHES_PER_SUBSCRIBER };

/** Thrown when a registration would exceed the v0.3.3 per-subscriber cap. */
export class PushSubscriptionLimitError extends Error {
  readonly subscriberId: string;

  constructor(subscriberId: string) {
    super('push subscription limit reached');
    this.name = 'PushSubscriptionLimitError';
    this.subscriberId = subscriberId;
  }
}

/** Raised atomically when a new unique Section would exceed the polite source budget. */
export class UniqueSectionCapacityError extends Error {
  readonly maxUniqueSections: number;

  constructor(maxUniqueSections: number) {
    super('unique section capacity reached');
    this.name = 'UniqueSectionCapacityError';
    this.maxUniqueSections = maxUniqueSections;
  }
}

/** Raised atomically when a registration would exceed the pilot subscriber cap. */
export class SubscriberCapacityError extends Error {
  readonly maxSubscribers: number;

  constructor(maxSubscribers: number) {
    super('subscriber capacity reached');
    this.name = 'SubscriberCapacityError';
    this.maxSubscribers = maxSubscribers;
  }
}

export interface CapacityAdmissionOptions {
  /**
   * Maximum distinct activated live Sections held by Confirmed subscribers.
   * Pending Watches are staged and reserve no source capacity; their complete
   * live set is checked atomically at first confirmation.
   */
  maxUniqueSections?: number;
  /**
   * Maximum total Pending + Confirmed subscriber rows admitted during the
   * pilot. Production may configure a lower value, but never above 100.
   */
  maxSubscribers?: number;
}

export const MAIL_ALERT_EXPIRY_MS = 60 * 60 * 1_000;
/**
 * The Blind-window horizon (FR-28 / ADR 0010): how long a watched Section must
 * go without a successful read before its watchers are told the system is not
 * watching it.
 *
 * DERIVED from the Alert expiry rather than introduced as a second tunable. The
 * product already treats seat information older than an hour as no longer
 * actionable, so an hour of not looking is exactly the point at which silence
 * stops being evidence that nothing happened. One horizon, one place to change.
 */
export const BLIND_WINDOW_MS = MAIL_ALERT_EXPIRY_MS;
export const MAIL_RETRY_HORIZON_MS = 23 * 60 * 60 * 1_000;
export const PENDING_SUBSCRIBER_RETENTION_MS = 72 * 60 * 60 * 1_000;
export const TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate and assert a string is a canonical ClassKey at the repo boundary.
 * Throws a Zod validation error if the key does not match CLASS_KEY_PATTERN.
 * Called before any insert so invalid strings never reach the DB.
 */
function assertClassKey(raw: string): ClassKey {
  return ClassKeySchema.parse(raw);
}

function assertPositiveCapacity(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('maxUniqueSections must be a positive safe integer');
  }
  return value;
}

function assertSubscriberCapacityLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new TypeError('maxSubscribers must be an integer from 1 to 100');
  }
  return value;
}

function outboxIdentity(kind: MailOutboxKind): {
  id: string;
  providerIdempotencyKey: string;
} {
  const id = crypto.randomUUID();
  return { id, providerIdempotencyKey: `seat-sniper/${kind}/${id}` };
}

/**
 * Stable provider key for one Blind-window disclosure (FR-28). Deterministic in
 * the same three values the logical unique index keys on, so a retry, a restart,
 * or a second worker derives a byte-identical key. Carries an opaque subscriber
 * id and a canonical class key only — never an address (constitution / AC-8).
 */
function blindWindowIdempotencyKey(input: {
  subscriberId: string;
  classKey: ClassKey;
  windowStartedAt: Date;
}): string {
  return `seat-sniper/blind-window/${input.subscriberId}/${input.classKey}/${input.windowStartedAt.toISOString()}`;
}

function legacyAlertIdempotencyKey(input: {
  subscriberId: string;
  classKey: ClassKey;
  openedAt: Date;
}): string {
  return `seat-sniper/alert/${input.subscriberId}/${input.classKey}/${input.openedAt.toISOString()}`;
}

async function assertUniqueSectionCapacity(
  db: Db,
  classKeys: ClassKey[],
  maxUniqueSections: number | undefined,
): Promise<void> {
  const maximum = assertPositiveCapacity(maxUniqueSections);
  if (maximum === undefined || classKeys.length === 0) return;

  const [totalRow] = await db
    .select({ value: countDistinct(watches.classKey) })
    .from(watches)
    .innerJoin(subscribers, eq(watches.subscriberId, subscribers.id))
    .where(
      and(
        isNull(watches.retiredAt),
        isNotNull(watches.activatedAt),
        isNotNull(watches.activationOrder),
        isNotNull(subscribers.confirmedAt),
      ),
    );

  const existingRows = await db
    .selectDistinct({ classKey: watches.classKey })
    .from(watches)
    .innerJoin(subscribers, eq(watches.subscriberId, subscribers.id))
    .where(
      and(
        isNull(watches.retiredAt),
        isNotNull(watches.activatedAt),
        isNotNull(watches.activationOrder),
        isNotNull(subscribers.confirmedAt),
        inArray(watches.classKey, classKeys),
      ),
    );

  const uniqueRequested = new Set(classKeys).size;
  const newUnique = uniqueRequested - existingRows.length;
  if ((totalRow?.value ?? 0) + newUnique > maximum) {
    throw new UniqueSectionCapacityError(maximum);
  }
}

async function enqueueSubscriberMailInTransaction(
  db: Db,
  kind: 'confirmation' | 'manage-link',
  subscriberId: string,
): Promise<string> {
  const identity = outboxIdentity(kind);
  await db.insert(mailOutbox).values({
    ...identity,
    kind,
    subscriberId,
    payload: {},
  });
  return identity.id;
}

async function enqueueOperatorMailInTransaction(
  db: Db,
  input: { classKey?: ClassKey; detail: string },
): Promise<string> {
  if (input.detail.length < 1 || input.detail.length > 4_096) {
    throw new TypeError('operator detail must contain 1 to 4096 characters');
  }
  const classKey = input.classKey ? assertClassKey(input.classKey) : undefined;
  const identity = outboxIdentity('operator');
  await db.insert(mailOutbox).values({
    ...identity,
    kind: 'operator',
    classKey,
    payload: { detail: input.detail },
  });
  return identity.id;
}

/**
 * Explicit lock ordering for the poll/activation visibility boundary.
 *
 * Poll-state writes take SHARE briefly; watch mutations take SHARE ROW EXCLUSIVE
 * before locking subscriber rows. The latter serializes short activation/
 * retirement transactions so a confirm, add, and class-gone update have one
 * unambiguous order. Doing it first also prevents a subscriber-row ↔ watch-table
 * deadlock while a state transaction claims alert rows with subscriber FKs.
 */
async function lockWatchTableForActivation(db: Db): Promise<void> {
  await db.execute(sql.raw('LOCK TABLE "watches" IN SHARE ROW EXCLUSIVE MODE'));
}

async function assertSubscriberCapacity(db: Db, maximum: number): Promise<void> {
  // This table lock is held through commit. It serializes the count+insert with
  // other registrations and with deletes, so capacity cannot be oversubscribed.
  // Callers acquire the watches lock first to preserve repository lock ordering.
  await db.execute(sql.raw('LOCK TABLE "subscribers" IN SHARE ROW EXCLUSIVE MODE'));
  const [row] = await db.select({ value: count() }).from(subscribers);
  if ((row?.value ?? 0) >= maximum) {
    throw new SubscriberCapacityError(maximum);
  }
}

async function lockWatchTableForObservation(db: Db): Promise<void> {
  await db.execute(sql.raw('LOCK TABLE "watches" IN SHARE MODE'));
}

async function lockParserHealthForTransition(db: Db): Promise<void> {
  // An absent row cannot be row-locked. This short table lock serializes the
  // first broken episode with recovery/failover without spanning any network
  // work; the Operator job is only enqueued inside this transaction.
  await db.execute(sql.raw('LOCK TABLE "parser_health" IN SHARE ROW EXCLUSIVE MODE'));
}

function nextWatchVisibilityOrder() {
  return sql`nextval('watch_visibility_order_seq')`;
}

async function cancelDeliveriesClosedByState(
  db: Db,
  state: { classKey: ClassKey; lastOpenSeats: number; lastWaitlistOpen: boolean },
): Promise<void> {
  const closedReasons: NotifyReason[] = [];
  if (state.lastOpenSeats === 0) closedReasons.push('seats-open');
  if (!state.lastWaitlistOpen) closedReasons.push('waitlist-open');
  if (closedReasons.length === 0) return;

  await db
    .update(alertDeliveries)
    .set({
      cancelledAt: sql`clock_timestamp()`,
      terminalAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(alertDeliveries.classKey, state.classKey),
        inArray(alertDeliveries.reason, closedReasons),
        isNull(alertDeliveries.sentAt),
        isNull(alertDeliveries.cancelledAt),
        isNull(alertDeliveries.deadLetteredAt),
      ),
    );

  await db
    .update(mailOutbox)
    .set({
      status: 'cancelled',
      claimedAt: null,
      claimToken: null,
      terminalAt: sql`clock_timestamp()`,
      terminalReason: 'opening-closed',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(mailOutbox.kind, 'alert'),
        eq(mailOutbox.classKey, state.classKey),
        inArray(mailOutbox.reason, closedReasons),
        inArray(mailOutbox.status, ['queued', 'processing']),
      ),
    );
}

/**
 * Walk the cause chain of an error (bounded to 8 hops) and return the Postgres
 * constraint name if this is a unique-violation (SQLSTATE 23505), or undefined
 * if it is not. Handles drizzle 0.45+ which wraps driver errors in a
 * DrizzleQueryError with the original PGlite/node-postgres error on `.cause`.
 *
 * PGlite is Postgres-compatible and surfaces the same `code`/`constraint_name`
 * fields as node-postgres, just nested one level deeper under drizzle's wrapper.
 *
 * Returns the constraint name string (e.g. `subscribers_email_unique`,
 * `watches_subscriber_class_uq`) so callers can throw the right typed error.
 * Returns an empty string '' when SQLSTATE 23505 is confirmed but no constraint
 * name field is present (should not happen in practice).
 */
function uniqueViolationConstraint(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 8 && e != null; i++) {
    if (typeof e === 'object' && e !== null) {
      const obj = e as Record<string, unknown>;
      if (obj['code'] === '23505') {
        // node-postgres exposes `constraint`; PGlite exposes `constraint_name`.
        const name =
          typeof obj['constraint_name'] === 'string'
            ? obj['constraint_name']
            : typeof obj['constraint'] === 'string'
              ? obj['constraint']
              : '';
        return name;
      }
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Fetch the current LIVE watch list for a subscriber as an array of ClassKey.
 * Internal helper — avoids duplicating the query across addWatch, removeWatch,
 * and createSubscriberWithWatches. Each classKey was validated before insert;
 * the cast to ClassKey is safe.
 *
 * Filters out retired watches (`retired_at IS NOT NULL`): the contract's
 * GetSubscriptionResponse and AddWatchResponse both list LIVE watches only
 * (spec §4 — "watches lists LIVE (un-retired) watches only"). A retired watch
 * silently leaves the manage view (FR-13 / spec §2 non-goal).
 */
async function fetchWatchList(db: Db, subscriberId: string): Promise<ClassKey[]> {
  const rows = await db
    .select({ classKey: watches.classKey })
    .from(watches)
    .where(and(eq(watches.subscriberId, subscriberId), isNull(watches.retiredAt)))
    .orderBy(asc(watches.createdAt), asc(watches.id));
  return rows.map((r) => r.classKey as ClassKey);
}

// ---------------------------------------------------------------------------
// Subscription / watch operations
// ---------------------------------------------------------------------------

/**
 * Create a new subscriber with an initial set of watches, atomically.
 *
 * INSERT-ONLY semantics (security requirement — see DuplicateSubscriberError):
 *   - New email   → inserts subscriber + de-duped watches, returns {subscriberId, watches}.
 *   - Known email → throws DuplicateSubscriberError (backend maps to 409 conflict).
 *
 * Duplicate class keys within the input array are silently de-duped via Set
 * before insertion. All class keys are validated with ClassKeySchema at the
 * boundary before any DB write.
 *
 * PII note: email is never logged here or anywhere in this file (AC-8).
 */
export async function createSubscriberWithWatches(
  db: Db,
  email: string,
  classKeys: ClassKey[],
  options: CapacityAdmissionOptions = {},
): Promise<{
  subscriberId: string;
  watches: ClassKey[];
  watchFreshness: WatchFreshnessRecord[];
}> {
  // Validate and de-dupe class keys at the boundary before touching the DB.
  const validatedKeys = [...new Set(classKeys.map(assertClassKey))];
  const validatedEmail = SubscriberEmailSchema.parse(email);
  const maxSubscribers = assertSubscriberCapacityLimit(options.maxSubscribers);

  return await db.transaction(async (tx) => {
    // Defence in depth for direct repository callers. HTTP validation rejects
    // an over-cap create before this point, but the transaction must preserve
    // the invariant independently and before any Subscriber/Watch/outbox write.
    if (validatedKeys.length > MAX_WATCHES_PER_SUBSCRIBER) {
      throw new WatchLimitError();
    }

    await lockWatchTableForActivation(tx as unknown as Db);
    if (maxSubscribers !== undefined) {
      await assertSubscriberCapacity(tx as unknown as Db, maxSubscribers);
    }
    // Insert-only: throw DuplicateSubscriberError on email conflict rather than
    // merging into an existing subscription. This prevents account-takeover via
    // unauthenticated create (spec §4 / AC-2b).
    let subscriberId: string;
    try {
      // Use the no-argument .returning() form (returns all columns) to avoid
      // a TypeScript overload resolution issue with the union Db type inside
      // a transaction callback. We pick only `id` from the result.
      const [subscriber] = await tx
        .insert(subscribers)
        .values({ email: validatedEmail })
        .returning();
      subscriberId = subscriber.id;
    } catch (err) {
      // drizzle 0.45 wraps the driver error; walk the cause chain for SQLSTATE
      // 23505. The only unique constraint on subscribers is `subscribers_email_unique`
      // so any 23505 here is a duplicate email.
      if (uniqueViolationConstraint(err) !== undefined) {
        throw new DuplicateSubscriberError();
      }
      throw err;
    }

    // Pending Watches are staged with NULL activation fields and reserve no
    // source capacity. First confirmation activates the complete live set
    // atomically after checking Confirmed demand.
    if (validatedKeys.length > 0) {
      await tx
        .insert(watches)
        .values(
          validatedKeys.map((classKey) => ({
            subscriberId,
            classKey,
            activatedAt: null,
            activationOrder: null,
          })),
        )
        .onConflictDoNothing();
    }

    // Confirmation delivery is part of the same commit as the Pending account.
    // A pre-existing suppression withholds it, while dispatch re-checks to close
    // the race with a suppression arriving after this transaction.
    const [suppression] = await tx
      .select({ email: suppressions.email })
      .from(suppressions)
      .where(eq(suppressions.email, validatedEmail))
      .limit(1);
    if (!suppression) {
      await enqueueSubscriberMailInTransaction(tx as unknown as Db, 'confirmation', subscriberId);
    }

    // Read the response in the mutation transaction. If response hydration
    // fails, the subscriber, watches, and confirmation job all roll back.
    const watchFreshness = await fetchWatchFreshness(tx as unknown as Db, subscriberId);
    return {
      subscriberId,
      watches: watchFreshness.map((entry) => entry.classKey),
      watchFreshness,
    };
  });
}

/** The fields a subscriber lookup returns. `confirmedAt` realizes the
 * Pending/Confirmed state (FR-9): null = Pending, a Date = Confirmed. The
 * backend derives the contract's `confirmed: boolean` from `confirmedAt !== null`
 * and gates push registration (409 while Pending). `email` is PII — never log. */
export interface SubscriberLookup {
  id: string;
  email: string;
  confirmedAt: Date | null;
  createdAt: Date;
}

/**
 * Look up a subscriber by their opaque id.
 * Returns undefined if no row exists.
 * Never log the returned email (constitution / AC-8).
 */
export async function getSubscriberById(db: Db, id: string): Promise<SubscriberLookup | undefined> {
  const [row] = await db.select().from(subscribers).where(eq(subscribers.id, id)).limit(1);
  return row
    ? { id: row.id, email: row.email, confirmedAt: row.confirmedAt, createdAt: row.createdAt }
    : undefined;
}

/**
 * Look up a subscriber by their email address.
 * Returns undefined if no row exists.
 * Never log the returned email (constitution / AC-8).
 */
export async function getSubscriberByEmail(
  db: Db,
  email: string,
): Promise<SubscriberLookup | undefined> {
  const [row] = await db.select().from(subscribers).where(eq(subscribers.email, email)).limit(1);
  return row
    ? { id: row.id, email: row.email, confirmedAt: row.confirmedAt, createdAt: row.createdAt }
    : undefined;
}

/**
 * Confirm a subscriber: set `confirmed_at` to now, IDEMPOTENTLY (FR-9 / AC-10).
 *
 * Sets the timestamp ONLY when it is currently NULL (Pending). Re-confirming an
 * already-Confirmed subscriber is a no-op — `confirmed_at` is never overwritten,
 * so the first-confirm time is preserved (the confirm endpoint returns the same
 * 200 both times and AC-10 asserts the timestamp is set exactly once).
 *
 * Returns the contract-pinned transition result. Capacity failure leaves the
 * Subscriber Pending and every live Watch staged; a later call can retry.
 * Missing subscribers throw SubscriberNotFoundError for the server's 404 map.
 */
export type ConfirmSubscriberResult = 'confirmed' | 'already_confirmed' | 'capacity_exceeded';

export async function confirmSubscriber(
  db: Db,
  id: string,
  options: CapacityAdmissionOptions = {},
): Promise<ConfirmSubscriberResult> {
  return db.transaction(async (tx) => {
    await lockWatchTableForActivation(tx as unknown as Db);
    const [subscriber] = await tx
      .select({ id: subscribers.id, confirmedAt: subscribers.confirmedAt })
      .from(subscribers)
      .where(eq(subscribers.id, id))
      .for('update')
      .limit(1);
    if (!subscriber) {
      throw new SubscriberNotFoundError(id);
    }
    // Permanently idempotent: capacity changes after confirmation cannot make a
    // second call fail or alter any activation timestamp/order.
    if (subscriber.confirmedAt !== null) return 'already_confirmed';

    // Validate/read capacity only after the idempotent Confirmed fast path.
    // Already-Confirmed is contractually independent of the current ceiling.
    const maxUniqueSections = assertPositiveCapacity(options.maxUniqueSections);
    const staged = await tx
      .select({ id: watches.id, classKey: watches.classKey })
      .from(watches)
      .where(and(eq(watches.subscriberId, id), isNull(watches.retiredAt)))
      .orderBy(asc(watches.createdAt), asc(watches.id));

    try {
      await assertUniqueSectionCapacity(
        tx as unknown as Db,
        staged.map((watch) => watch.classKey as ClassKey),
        maxUniqueSections,
      );
    } catch (error) {
      if (error instanceof UniqueSectionCapacityError) return 'capacity_exceeded';
      throw error;
    }

    await tx
      .update(subscribers)
      .set({ confirmedAt: sql`transaction_timestamp()` })
      .where(and(eq(subscribers.id, id), isNull(subscribers.confirmedAt)));

    // At most the contract cap of staged Watches exists. Updating in stable creation/id order
    // makes their monotonic activation order deterministic within this atomic
    // confirmation while using one transaction timestamp for the whole set.
    for (const watch of staged) {
      await tx
        .update(watches)
        .set({
          activatedAt: sql`transaction_timestamp()`,
          activationOrder: nextWatchVisibilityOrder(),
        })
        .where(and(eq(watches.id, watch.id), isNull(watches.retiredAt)));
    }
    return 'confirmed';
  });
}

/**
 * Add one watch for a subscriber.
 *
 * Returns the full updated LIVE watch list on success.
 *
 * Revive-on-readd (FR-13 / spec §4-§5): the (subscriber_id, class_key) unique
 * constraint spans live AND retired rows, so a re-add must REVIVE a retired row
 * (clear `retired_at`) rather than insert a duplicate — this honestly re-tests a
 * class that may have been re-listed and keeps the unique constraint intact.
 * Only a duplicate LIVE watch is a `409 conflict` (DuplicateWatchError).
 *
 * Implementation: INSERT … ON CONFLICT (subscriber_id, class_key) DO UPDATE SET
 * retired_at = NULL, returning the row's pre-update retired_at via a WHERE guard
 * is not expressible portably, so we do a conditional upsert and then detect the
 * live-duplicate case. We first look up the existing row's retired_at:
 *   - no row        → insert a fresh live watch.
 *   - retired row   → revive it (set retired_at = NULL).
 *   - live row      → throw DuplicateWatchError (409 conflict).
 * The read+write race window is closed by the unique constraint: a concurrent
 * insert still surfaces as a 23505 we map to DuplicateWatchError.
 *
 * classKey is validated with ClassKeySchema at the boundary.
 */
export async function addWatchWithFreshness(
  db: Db,
  subscriberId: string,
  classKey: ClassKey,
  options: CapacityAdmissionOptions = {},
): Promise<WatchFreshnessRecord[]> {
  const validatedKey = assertClassKey(classKey);

  return db.transaction(async (tx) => {
    await lockWatchTableForActivation(tx as unknown as Db);
    // Serialize every add/revival for this subscriber. A count without this
    // stable-row lock has a TOCTOU race where two concurrent final-slot watches both
    // pass and commit.
    const lockedSubscriber = await tx
      .select({ id: subscribers.id, confirmedAt: subscribers.confirmedAt })
      .from(subscribers)
      .where(eq(subscribers.id, subscriberId))
      .for('update');
    if (lockedSubscriber.length === 0) {
      throw new SubscriberNotFoundError(subscriberId);
    }

    const [existing] = await tx
      .select({ id: watches.id, retiredAt: watches.retiredAt })
      .from(watches)
      .where(and(eq(watches.subscriberId, subscriberId), eq(watches.classKey, validatedKey)))
      .limit(1);

    if (existing?.retiredAt === null) {
      throw new DuplicateWatchError(subscriberId, validatedKey);
    }

    const [live] = await tx
      .select({ value: count() })
      .from(watches)
      .where(and(eq(watches.subscriberId, subscriberId), isNull(watches.retiredAt)));
    if ((live?.value ?? 0) >= MAX_WATCHES_PER_SUBSCRIBER) {
      throw new WatchLimitError(subscriberId);
    }

    // Personal capacity is actionable immediately and therefore takes
    // precedence over the service-wide source ceiling (FR-24 / AC-32).
    const isConfirmed = lockedSubscriber[0]!.confirmedAt !== null;
    if (isConfirmed) {
      await assertUniqueSectionCapacity(
        tx as unknown as Db,
        [validatedKey],
        options.maxUniqueSections,
      );
    }

    if (existing) {
      const revived = await tx
        .update(watches)
        .set({
          retiredAt: null,
          activatedAt: isConfirmed ? sql`transaction_timestamp()` : null,
          activationOrder: isConfirmed ? nextWatchVisibilityOrder() : null,
        })
        .where(and(eq(watches.id, existing.id), isNotNull(watches.retiredAt)))
        .returning();
      if (revived.length === 0) {
        throw new DuplicateWatchError(subscriberId, validatedKey);
      }
    } else {
      try {
        await tx.insert(watches).values({
          subscriberId,
          classKey: validatedKey,
          activatedAt: isConfirmed ? sql`transaction_timestamp()` : null,
          activationOrder: isConfirmed ? nextWatchVisibilityOrder() : null,
        });
      } catch (err) {
        const constraint = uniqueViolationConstraint(err);
        if (constraint === 'watches_subscriber_class_uq') {
          throw new DuplicateWatchError(subscriberId, validatedKey);
        }
        throw err;
      }
    }

    // Hydrate the response before commit so a failed read rolls back the watch
    // mutation instead of surfacing a 500 after a successful write.
    return fetchWatchFreshness(tx as unknown as Db, subscriberId);
  });
}

/** Add one watch and return the full updated LIVE watch list. */
export async function addWatch(
  db: Db,
  subscriberId: string,
  classKey: ClassKey,
  options: CapacityAdmissionOptions = {},
): Promise<ClassKey[]> {
  const watchFreshness = await addWatchWithFreshness(db, subscriberId, classKey, options);
  return watchFreshness.map((entry) => entry.classKey);
}

/**
 * Remove one watch for a subscriber (explicit, user-initiated removal).
 *
 * HARD delete — distinct from class-gone retirement (retireWatchesForClass,
 * which soft-retires via retired_at). When a subscriber explicitly removes a
 * watch they no longer want it; deleting the row keeps the table small and lets
 * a later add re-create a fresh watch. (Retirement, by contrast, must be
 * revivable — see addWatch.)
 *
 * Idempotent — no error if the watch does not exist.
 * Returns the full updated LIVE watch list.
 */
export async function removeWatch(
  db: Db,
  subscriberId: string,
  classKey: ClassKey,
): Promise<ClassKey[]> {
  const validatedKey = assertClassKey(classKey);

  return db.transaction(async (tx) => {
    await lockWatchTableForActivation(tx as unknown as Db);
    await tx
      .delete(watches)
      .where(and(eq(watches.subscriberId, subscriberId), eq(watches.classKey, validatedKey)));

    await tx
      .update(mailOutbox)
      .set({
        status: 'cancelled',
        claimedAt: null,
        claimToken: null,
        terminalAt: sql`clock_timestamp()`,
        terminalReason: 'subscriber-ineligible',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(mailOutbox.kind, 'alert'),
          eq(mailOutbox.subscriberId, subscriberId),
          eq(mailOutbox.classKey, validatedKey),
          inArray(mailOutbox.status, ['queued', 'processing']),
        ),
      );

    return fetchWatchList(tx as unknown as Db, subscriberId);
  });
}

async function detachProtectedDeadLettersForSubscriber(
  db: Db,
  subscriberId: string,
): Promise<void> {
  await db
    .update(mailOutbox)
    .set({
      subscriberId: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(mailOutbox.subscriberId, subscriberId),
        eq(mailOutbox.status, 'dead_letter'),
        sql`exists (
          select 1
          from ${deadLetterIncidents}
          where ${deadLetterIncidents.mailJobId} = ${mailOutbox.id}
            and ${deadLetterIncidents.state} in ('unresolved', 'acknowledged')
        )`,
      ),
    );
}

/**
 * Delete a subscriber and cascade to their watches.
 *
 * Idempotent — no error if the subscriber does not exist.
 * FK onDelete: 'cascade' removes all their watch rows automatically.
 */
export async function deleteSubscriber(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockWatchTableForActivation(tx as unknown as Db);
    // Dead-letter incidents are operational records, not subscriber-facing
    // delivery work. Detach unresolved/acknowledged jobs so the subscriber FK
    // cascade cannot erase them before explicit resolution.
    await detachProtectedDeadLettersForSubscriber(tx as unknown as Db, id);
    await tx.delete(subscribers).where(eq(subscribers.id, id));
  });
}

/**
 * List the canonical class keys currently watched by a subscriber.
 */
export async function listWatches(db: Db, subscriberId: string): Promise<ClassKey[]> {
  return fetchWatchList(db, subscriberId);
}

export interface WatchFreshnessRecord {
  classKey: ClassKey;
  lastCheckedAt: Date | null;
  sourceFreshUntil: Date | null;
  sourceStale: boolean;
  displayName: string | null;
  openSeats: number | null;
  enrolled: number | null;
  capacity: number | null;
  waitlisted: number | null;
  waitlistMax: number | null;
  openReserved: number | null;
  waitlistOpen: boolean | null;
}

/**
 * Return freshness in exactly the same stable order as `listWatches`.
 * Database time is used for staleness so API instances cannot disagree because
 * their host clocks drift.
 */
async function fetchWatchFreshness(db: Db, subscriberId: string): Promise<WatchFreshnessRecord[]> {
  const rows = await db
    .select({
      classKey: watches.classKey,
      lastCheckedAt: classState.updatedAt,
      sourceFreshUntil: classState.sourceFreshUntil,
      sourceStale: sql<boolean>`${classState.classKey} is null
        or ${classState.sourceFreshUntil} <= clock_timestamp()`,
      displayName: classState.displayName,
      openSeats: classState.lastOpenSeats,
      enrolled: classState.lastEnrolled,
      capacity: classState.lastCapacity,
      waitlisted: classState.lastWaitlisted,
      waitlistMax: classState.lastWaitlistMax,
      openReserved: classState.lastOpenReserved,
      waitlistOpen: classState.lastWaitlistOpen,
    })
    .from(watches)
    .leftJoin(classState, eq(watches.classKey, classState.classKey))
    .where(and(eq(watches.subscriberId, subscriberId), isNull(watches.retiredAt)))
    .orderBy(asc(watches.createdAt), asc(watches.id));

  return rows.map((row) => ({
    classKey: row.classKey as ClassKey,
    lastCheckedAt: row.lastCheckedAt,
    sourceFreshUntil: row.sourceFreshUntil,
    sourceStale: row.sourceStale,
    displayName: row.displayName,
    openSeats: row.openSeats,
    enrolled: row.enrolled,
    capacity: row.capacity,
    waitlisted: row.waitlisted,
    waitlistMax: row.waitlistMax,
    openReserved: row.openReserved,
    waitlistOpen: row.waitlistOpen,
  }));
}

export async function listWatchFreshness(
  db: Db,
  subscriberId: string,
): Promise<WatchFreshnessRecord[]> {
  return fetchWatchFreshness(db, subscriberId);
}

/** Count distinct activated live Sections held by Confirmed subscribers. */
export async function countDistinctLiveClassKeys(db: Db): Promise<number> {
  const [row] = await db
    .select({ value: countDistinct(watches.classKey) })
    .from(watches)
    .innerJoin(subscribers, eq(watches.subscriberId, subscribers.id))
    .where(
      and(
        isNull(watches.retiredAt),
        isNotNull(watches.activatedAt),
        isNotNull(watches.activationOrder),
        isNotNull(subscribers.confirmedAt),
      ),
    );
  return row?.value ?? 0;
}

/** Whether a Section already consumes one Confirmed source-capacity slot. */
export async function hasLiveWatchForClass(db: Db, classKey: ClassKey): Promise<boolean> {
  const [row] = await db
    .select({ id: watches.id })
    .from(watches)
    .innerJoin(subscribers, eq(watches.subscriberId, subscribers.id))
    .where(
      and(
        eq(watches.classKey, assertClassKey(classKey)),
        isNull(watches.retiredAt),
        isNotNull(watches.activatedAt),
        isNotNull(watches.activationOrder),
        isNotNull(subscribers.confirmedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Worker fan-out operations
// ---------------------------------------------------------------------------

/**
 * Return all distinct class keys with at least one LIVE (un-retired) watch held
 * by a CONFIRMED subscriber. The poller calls this once per cycle to build its
 * fetch queue (FR-3 / v0.3.3 confirmed-demand rule).
 *
 * Pending subscribers cannot drive upstream traffic: unauthenticated subscribe
 * requests otherwise become a scrape-amplification primitive. Suppression is
 * deliberately not part of this query; the binding contract narrows demand by
 * confirmation state only and suppression remains a send-time decision.
 *
 * Uses the watches_class_key_idx index (the retired_at predicate is applied on
 * top of the index scan; live rows dominate so a partial index is not needed).
 */
export async function getDistinctWatchedClassKeys(db: Db): Promise<ClassKey[]> {
  const rows = await db
    .selectDistinct({ classKey: watches.classKey })
    .from(watches)
    .innerJoin(subscribers, eq(watches.subscriberId, subscribers.id))
    .where(
      and(
        isNull(watches.retiredAt),
        isNotNull(watches.activatedAt),
        isNotNull(watches.activationOrder),
        isNotNull(subscribers.confirmedAt),
      ),
    );
  return rows.map((r) => r.classKey as ClassKey);
}

/**
 * Return CONFIRMED subscribers with a LIVE watch on a given class key.
 * Used by the worker to fan out notifications after a seat transition (FR-4).
 *
 * Two filters realize the contract (FR-9 / FR-13 / AC-9 / AC-14):
 *   - `subscribers.confirmed_at IS NOT NULL` — only Confirmed subscribers receive
 *     Alerts; a Pending subscriber appears in NO alert (AC-9).
 *   - `watches.retired_at IS NULL` — a retired (class-gone) watch triggers no
 *     Alert.
 *
 * Returns only { id, email } — the minimum PII surface needed by the notifier.
 * Never log the returned emails (constitution / AC-8).
 *
 * Uses the watches_class_key_idx index.
 */
export async function getSubscribersWatching(
  db: Db,
  classKey: ClassKey,
): Promise<Array<{ id: string; email: string }>> {
  const validatedKey = assertClassKey(classKey);

  return db
    .select({ id: subscribers.id, email: subscribers.email })
    .from(watches)
    .innerJoin(subscribers, eq(watches.subscriberId, subscribers.id))
    .where(
      and(
        eq(watches.classKey, validatedKey),
        isNull(watches.retiredAt),
        isNotNull(watches.activatedAt),
        isNotNull(watches.activationOrder),
        // Only Confirmed subscribers (FR-9): confirmed_at is set.
        sql`${subscribers.confirmedAt} is not null`,
      ),
    );
}

/**
 * Retire EVERY watch on a class (class-gone, FR-13 / D8 / AC-14).
 *
 * Soft-retire by stamping `retired_at = now()` on all live rows for the class —
 * it is no longer polled (getDistinctWatchedClassKeys filters it out), no longer
 * fanned out (getSubscribersWatching filters it out), and no longer listed in the
 * manage view (fetchWatchList filters it out). The worker calls this on a
 * class-gone signal; it does NOT page the operator and does NOT alert subscribers.
 * `class_state` is untouched (the worker never calls upsertClassState on a
 * class-gone cycle). Re-adding the class via addWatch revives the row.
 *
 * Only touches rows that are currently live (`retired_at IS NULL`) so re-running
 * it does not bump the retirement timestamp of already-retired rows. Idempotent.
 *
 * Returns the number of watches retired (count only — never log the rows / PII).
 * Uses the watches_class_key_idx index.
 */
export async function getPollCycleCutoff(db: Db): Promise<string> {
  return db.transaction(async (tx) => {
    // Wait for every earlier activation writer and briefly block later writers,
    // then allocate a monotonic visibility boundary. The lock ends with this
    // tiny transaction; no database transaction spans a network fetch.
    await lockWatchTableForObservation(tx as unknown as Db);
    const result = (await tx.execute(
      sql`select nextval('watch_visibility_order_seq')::text as value`,
    )) as unknown as {
      rows: Array<{ value: string }>;
    };
    const [row] = result.rows;
    if (!row?.value) throw new Error('database did not return a poll-cycle cutoff');
    return row.value;
  });
}

export async function retireWatchesForClass(
  db: Db,
  classKey: ClassKey,
  activationOrderThrough?: string,
): Promise<number> {
  const validatedKey = assertClassKey(classKey);

  return db.transaction(async (tx) => {
    await lockWatchTableForActivation(tx as unknown as Db);
    // No-argument .returning(): the union `Db` type cannot resolve the
    // columns-argument overload here; we only need the count of retired rows.
    const retired = await tx
      .update(watches)
      .set({ retiredAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(watches.classKey, validatedKey),
          isNull(watches.retiredAt),
          activationOrderThrough
            ? or(
                isNull(watches.activationOrder),
                sql`${watches.activationOrder} <= ${activationOrderThrough}::bigint`,
              )
            : undefined,
        ),
      )
      .returning();

    await tx
      .update(alertDeliveries)
      .set({
        cancelledAt: sql`clock_timestamp()`,
        terminalAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(alertDeliveries.classKey, validatedKey),
          isNull(alertDeliveries.sentAt),
          isNull(alertDeliveries.cancelledAt),
          isNull(alertDeliveries.deadLetteredAt),
        ),
      );

    await tx
      .update(mailOutbox)
      .set({
        status: 'cancelled',
        claimedAt: null,
        claimToken: null,
        terminalAt: sql`clock_timestamp()`,
        terminalReason: 'subscriber-ineligible',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          // A vanished Section retires its Watches and deliberately tells no
          // Subscriber (FR-13). A queued Blind-window disclosure would break
          // that: it would announce we stopped watching a class that no longer
          // exists, moments before the Watch disappears from the dashboard.
          inArray(mailOutbox.kind, ['alert', 'blind-window']),
          eq(mailOutbox.classKey, validatedKey),
          inArray(mailOutbox.status, ['queued', 'processing']),
        ),
      );

    return retired.length;
  });
}

/**
 * Get the last-known state for a class key.
 * Returns undefined if no row exists yet (first poll for this class).
 *
 * Uses the class_state primary key index.
 */
export async function getClassState(
  db: Db,
  classKey: ClassKey,
): Promise<
  | {
      classKey: ClassKey;
      lastStatus: SeatStatus;
      lastOpenSeats: number;
      lastWaitlistOpen: boolean;
      displayName: string | null;
      lastEnrolled: number | null;
      lastCapacity: number | null;
      lastWaitlisted: number | null;
      lastWaitlistMax: number | null;
      lastOpenReserved: number | null;
      stateVersion: number;
      sourceFreshUntil: Date;
      updatedAt: Date;
    }
  | undefined
> {
  const validatedKey = assertClassKey(classKey);

  const [row] = await db
    .select()
    .from(classState)
    .where(eq(classState.classKey, validatedKey))
    .limit(1);

  if (!row) return undefined;

  return {
    classKey: row.classKey as ClassKey,
    lastStatus: row.lastStatus as SeatStatus,
    lastOpenSeats: row.lastOpenSeats,
    lastWaitlistOpen: row.lastWaitlistOpen,
    displayName: row.displayName,
    lastEnrolled: row.lastEnrolled,
    lastCapacity: row.lastCapacity,
    lastWaitlisted: row.lastWaitlisted,
    lastWaitlistMax: row.lastWaitlistMax,
    lastOpenReserved: row.lastOpenReserved,
    stateVersion: row.stateVersion,
    sourceFreshUntil: row.sourceFreshUntil,
    updatedAt: row.updatedAt,
  };
}

/**
 * Upsert the class state after a successful parse.
 *
 * MUST NOT be called when the scraper emits parser-broke — only call this
 * with a real SeatState (FR-6 / AC-5). The worker is responsible for this
 * gate; this function does not enforce it.
 *
 * Uses INSERT … ON CONFLICT (class_key) DO UPDATE to overwrite atomically.
 */
export async function upsertClassState(
  db: Db,
  state: {
    classKey: ClassKey;
    lastStatus: SeatStatus;
    lastOpenSeats: number;
    lastWaitlistOpen: boolean;
    displayName: string | null;
    lastEnrolled: number | null;
    lastCapacity: number | null;
    lastWaitlisted: number | null;
    lastWaitlistMax: number | null;
    lastOpenReserved: number | null;
    sourceFreshUntil?: Date;
  },
): Promise<void> {
  const validatedKey = assertClassKey(state.classKey);
  assertPersistableClassStateCounts(state);
  const sourceFreshUntil = state.sourceFreshUntil ?? new Date(Date.now() + 120 * 1_000);
  if (Number.isNaN(sourceFreshUntil.getTime())) {
    throw new TypeError('sourceFreshUntil must be a valid Date');
  }

  await db.transaction(async (tx) => {
    // Establish one exact visibility boundary between activation commits and
    // this successful baseline observation.
    await lockWatchTableForObservation(tx as unknown as Db);
    await tx
      .insert(classState)
      .values({
        classKey: validatedKey,
        lastStatus: state.lastStatus,
        lastOpenSeats: state.lastOpenSeats,
        lastWaitlistOpen: state.lastWaitlistOpen,
        displayName: state.displayName,
        lastEnrolled: state.lastEnrolled,
        lastCapacity: state.lastCapacity,
        lastWaitlisted: state.lastWaitlisted,
        lastWaitlistMax: state.lastWaitlistMax,
        lastOpenReserved: state.lastOpenReserved,
        sourceFreshUntil,
        observedWatchOrder: nextWatchVisibilityOrder(),
        updatedAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: classState.classKey,
        set: {
          lastStatus: state.lastStatus,
          lastOpenSeats: state.lastOpenSeats,
          lastWaitlistOpen: state.lastWaitlistOpen,
          displayName: state.displayName,
          lastEnrolled: state.lastEnrolled,
          lastCapacity: state.lastCapacity,
          lastWaitlisted: state.lastWaitlisted,
          lastWaitlistMax: state.lastWaitlistMax,
          lastOpenReserved: state.lastOpenReserved,
          sourceFreshUntil,
          stateVersion: sql`${classState.stateVersion} + 1`,
          observedWatchOrder: nextWatchVisibilityOrder(),
          updatedAt: sql`clock_timestamp()`,
        },
      });
    await cancelDeliveriesClosedByState(tx as unknown as Db, {
      classKey: validatedKey,
      lastOpenSeats: state.lastOpenSeats,
      lastWaitlistOpen: state.lastWaitlistOpen,
    });
  });
}

export type RecordParserBrokenResult =
  | { status: 'opened'; mailJobId: string }
  | { status: 'already-broken' };

/**
 * Open one durable parser-broke episode and enqueue exactly one Operator job.
 *
 * The parser-health transition and outbox insert share a transaction. A
 * persistent break is therefore a no-op across cycles, restart, and worker
 * failover; any enqueue fault rolls the episode transition back.
 */
export async function recordParserBroken(
  db: Db,
  input: { classKey: ClassKey; detail: string },
): Promise<RecordParserBrokenResult> {
  const classKey = assertClassKey(input.classKey);
  if (input.detail.length < 1 || input.detail.length > 4_096) {
    throw new TypeError('operator detail must contain 1 to 4096 characters');
  }

  return db.transaction(async (tx) => {
    await lockParserHealthForTransition(tx as unknown as Db);
    const [current] = await tx
      .select({ status: parserHealth.status })
      .from(parserHealth)
      .where(eq(parserHealth.classKey, classKey))
      .for('update')
      .limit(1);
    if (current?.status === 'broken') return { status: 'already-broken' };

    if (current) {
      await tx
        .update(parserHealth)
        .set({
          status: 'broken',
          episodeStartedAt: sql`transaction_timestamp()`,
          alertEnqueuedAt: sql`transaction_timestamp()`,
          recoveredAt: null,
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(eq(parserHealth.classKey, classKey));
    } else {
      await tx.insert(parserHealth).values({
        classKey,
        status: 'broken',
        episodeStartedAt: sql`transaction_timestamp()`,
        alertEnqueuedAt: sql`transaction_timestamp()`,
        recoveredAt: null,
        updatedAt: sql`transaction_timestamp()`,
      });
    }

    const mailJobId = await enqueueOperatorMailInTransaction(tx as unknown as Db, {
      classKey,
      detail: input.detail,
    });
    return { status: 'opened', mailJobId };
  });
}

/**
 * Record successful-parse recovery for a currently broken Section.
 *
 * Returns true only for the broken → healthy transition. Healthy/absent state
 * is an idempotent no-op; class-gone callers must not invoke this primitive.
 */
export async function recordParserRecovery(db: Db, classKey: ClassKey): Promise<boolean> {
  const validatedKey = assertClassKey(classKey);
  return db.transaction(async (tx) => {
    await lockParserHealthForTransition(tx as unknown as Db);
    const recovered = await tx
      .update(parserHealth)
      .set({
        status: 'healthy',
        recoveredAt: sql`transaction_timestamp()`,
        updatedAt: sql`transaction_timestamp()`,
      })
      .where(and(eq(parserHealth.classKey, validatedKey), eq(parserHealth.status, 'broken')))
      .returning();
    return recovered.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Durable alert-delivery operations (FR-4 / v0.3.3)
// ---------------------------------------------------------------------------

/** The durable identity and original non-PII payload of one opening alert. */
export interface AlertDeliveryInput {
  subscriberId: string;
  classKey: ClassKey;
  /** ISO-8601 timestamp used by NotifyEvent and the durable composite key. */
  openedAt: string;
  reason: NotifyReason;
  openSeats: number;
  /** Reserved subset observed at this opening; null means the page did not publish it. */
  openReserved: number | null;
}

/** Result of an idempotent delivery-ledger claim. */
export type AlertDeliveryClaimStatus = 'claimed' | 'pending' | 'sent';

/** Pending retry joined to the current subscriber address for dispatch only. */
export interface PendingAlertDelivery extends AlertDeliveryInput {
  email: string;
  createdAt: Date;
}

/**
 * One observed opening plus the exact prior state being replaced. The worker
 * uses this operation to commit the state transition and all delivery claims in
 * one transaction; otherwise a crash between those writes can either lose a
 * subscriber or manufacture a second opening on restart.
 */
export interface OpeningTransitionInput {
  classKey: ClassKey;
  previousStateVersion: number;
  openedAt: string;
  reason: NotifyReason;
  openSeats: number;
  nextState: {
    lastStatus: SeatStatus;
    lastOpenSeats: number;
    lastWaitlistOpen: boolean;
    displayName: string | null;
    lastEnrolled: number | null;
    lastCapacity: number | null;
    lastWaitlisted: number | null;
    lastWaitlistMax: number | null;
    lastOpenReserved: number | null;
    sourceFreshUntil?: Date;
  };
}

function openedAtDate(openedAt: string): Date {
  const parsed = new Date(openedAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError('openedAt must be an ISO-8601 timestamp');
  }
  return parsed;
}

function assertPersistableCount(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_OBSERVED_COUNT) {
    throw new TypeError(
      `${field} must be a non-negative integer no greater than ${MAX_OBSERVED_COUNT}`,
    );
  }
}

function assertPersistableNullableCount(field: string, value: number | null): void {
  if (value !== null) assertPersistableCount(field, value);
}

function assertPersistableClassStateCounts(state: {
  lastOpenSeats: number;
  lastEnrolled: number | null;
  lastCapacity: number | null;
  lastWaitlisted: number | null;
  lastWaitlistMax: number | null;
  lastOpenReserved: number | null;
}): void {
  assertPersistableCount('lastOpenSeats', state.lastOpenSeats);
  assertPersistableNullableCount('lastEnrolled', state.lastEnrolled);
  assertPersistableNullableCount('lastCapacity', state.lastCapacity);
  assertPersistableNullableCount('lastWaitlisted', state.lastWaitlisted);
  assertPersistableNullableCount('lastWaitlistMax', state.lastWaitlistMax);
  assertPersistableNullableCount('lastOpenReserved', state.lastOpenReserved);
  if (state.lastOpenReserved !== null && state.lastOpenReserved > state.lastOpenSeats) {
    throw new TypeError('lastOpenReserved must be no greater than lastOpenSeats');
  }
}

function assertPersistableOpenSeats(openSeats: number): void {
  assertPersistableCount('openSeats', openSeats);
}

function assertPersistableOpenReserved(openSeats: number, openReserved: number | null): void {
  assertPersistableNullableCount('openReserved', openReserved);
  if (openReserved !== null && openReserved > openSeats) {
    throw new TypeError('openReserved must be no greater than openSeats');
  }
}

/**
 * Claim a durable delivery before dispatch.
 *
 * `claimed` means this call inserted the row and owns the first attempt.
 * `pending` means an earlier attempt claimed but did not mark it; the cycle-level
 * retry scan owns that retry rather than this transition path. `sent` is a
 * durable no-op. This split prevents two transition workers that race on the
 * same composite key from both treating the conflict as permission to send.
 */
export async function claimAlertDelivery(
  db: Db,
  delivery: AlertDeliveryInput,
): Promise<AlertDeliveryClaimStatus> {
  const classKey = assertClassKey(delivery.classKey);
  assertPersistableOpenSeats(delivery.openSeats);
  assertPersistableOpenReserved(delivery.openSeats, delivery.openReserved);
  const openedAt = openedAtDate(delivery.openedAt);

  const [watch] = await db
    .select({ activationOrder: watches.activationOrder })
    .from(watches)
    .where(
      and(
        eq(watches.subscriberId, delivery.subscriberId),
        eq(watches.classKey, classKey),
        isNull(watches.retiredAt),
        isNotNull(watches.activatedAt),
        isNotNull(watches.activationOrder),
      ),
    )
    .limit(1);
  if (!watch?.activationOrder) return 'pending';

  const inserted = await db
    .insert(alertDeliveries)
    .values({
      subscriberId: delivery.subscriberId,
      classKey,
      openedAt,
      reason: delivery.reason,
      openSeats: delivery.openSeats,
      openReserved: delivery.openReserved,
      watchActivationOrder: watch.activationOrder,
      expiresAt: new Date(openedAt.getTime() + MAIL_ALERT_EXPIRY_MS),
      providerIdempotencyKey: legacyAlertIdempotencyKey({
        subscriberId: delivery.subscriberId,
        classKey,
        openedAt,
      }),
    })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) return 'claimed';

  const [existing] = await db
    .select({ sentAt: alertDeliveries.sentAt })
    .from(alertDeliveries)
    .where(
      and(
        eq(alertDeliveries.subscriberId, delivery.subscriberId),
        eq(alertDeliveries.classKey, classKey),
        eq(alertDeliveries.openedAt, openedAt),
      ),
    )
    .limit(1);

  // A conflicting row cannot disappear while its subscriber remains, but
  // return pending defensively if a concurrent subscriber cascade removed it.
  return existing?.sentAt ? 'sent' : 'pending';
}

/** Mark a claimed delivery after dispatch succeeds; idempotent. */
export async function markAlertDeliverySent(
  db: Db,
  key: Pick<AlertDeliveryInput, 'subscriberId' | 'classKey' | 'openedAt'>,
): Promise<boolean> {
  const marked = await db
    .update(alertDeliveries)
    .set({
      sentAt: sql`clock_timestamp()`,
      terminalAt: sql`clock_timestamp()`,
      providerAcceptedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(alertDeliveries.subscriberId, key.subscriberId),
        eq(alertDeliveries.classKey, assertClassKey(key.classKey)),
        eq(alertDeliveries.openedAt, openedAtDate(key.openedAt)),
        isNull(alertDeliveries.sentAt),
        isNull(alertDeliveries.cancelledAt),
        isNull(alertDeliveries.deadLetteredAt),
      ),
    )
    .returning();
  return marked.length > 0;
}

/** Mark a pending row terminal when its subscriber/watch is no longer eligible. */
export async function cancelAlertDelivery(
  db: Db,
  key: Pick<AlertDeliveryInput, 'subscriberId' | 'classKey' | 'openedAt'>,
): Promise<boolean> {
  const cancelled = await db
    .update(alertDeliveries)
    .set({
      cancelledAt: sql`clock_timestamp()`,
      terminalAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(alertDeliveries.subscriberId, key.subscriberId),
        eq(alertDeliveries.classKey, assertClassKey(key.classKey)),
        eq(alertDeliveries.openedAt, openedAtDate(key.openedAt)),
        isNull(alertDeliveries.sentAt),
        isNull(alertDeliveries.cancelledAt),
        isNull(alertDeliveries.deadLetteredAt),
      ),
    )
    .returning();
  return cancelled.length > 0;
}

/**
 * Defer a failed provider attempt with per-row exponential backoff. This keeps
 * one poison row out of every cycle's oldest-ready batch while preserving the
 * durable retry-until-terminal contract.
 */
export async function deferAlertDelivery(
  db: Db,
  key: Pick<AlertDeliveryInput, 'subscriberId' | 'classKey' | 'openedAt'>,
): Promise<boolean> {
  const deferred = await db
    .update(alertDeliveries)
    .set({
      attemptCount: sql`${alertDeliveries.attemptCount} + 1`,
      // Cap the exponent before evaluating power(). PostgreSQL evaluates the
      // arguments to least(), so capping only the final seconds still overflows
      // after a long-lived poison delivery and makes that row permanently due.
      nextAttemptAt: sql`now() + make_interval(secs => least(3600, 30 * power(2, least(${alertDeliveries.attemptCount}, 7))))`,
    })
    .where(
      and(
        eq(alertDeliveries.subscriberId, key.subscriberId),
        eq(alertDeliveries.classKey, assertClassKey(key.classKey)),
        eq(alertDeliveries.openedAt, openedAtDate(key.openedAt)),
        isNull(alertDeliveries.sentAt),
        isNull(alertDeliveries.cancelledAt),
        isNull(alertDeliveries.deadLetteredAt),
        sql`${alertDeliveries.expiresAt} > clock_timestamp()`,
      ),
    )
    .returning();
  return deferred.length > 0;
}

/**
 * Refresh one queued delivery immediately before egress. A live, confirmed
 * subscriber and the same watch activation that existed when the row was
 * claimed are required; deletion/revival while queued makes it ineligible.
 */
export async function getEligibleAlertDelivery(
  db: Db,
  key: Pick<AlertDeliveryInput, 'subscriberId' | 'classKey' | 'openedAt'>,
): Promise<PendingAlertDelivery | undefined> {
  const classKey = assertClassKey(key.classKey);
  const [row] = await db
    .select({
      subscriberId: alertDeliveries.subscriberId,
      email: subscribers.email,
      classKey: alertDeliveries.classKey,
      openedAt: alertDeliveries.openedAt,
      reason: alertDeliveries.reason,
      openSeats: alertDeliveries.openSeats,
      openReserved: alertDeliveries.openReserved,
      createdAt: alertDeliveries.createdAt,
    })
    .from(alertDeliveries)
    .innerJoin(subscribers, eq(alertDeliveries.subscriberId, subscribers.id))
    .innerJoin(
      watches,
      and(
        eq(watches.subscriberId, alertDeliveries.subscriberId),
        eq(watches.classKey, alertDeliveries.classKey),
      ),
    )
    .where(
      and(
        eq(alertDeliveries.subscriberId, key.subscriberId),
        eq(alertDeliveries.classKey, classKey),
        eq(alertDeliveries.openedAt, openedAtDate(key.openedAt)),
        isNull(alertDeliveries.sentAt),
        isNull(alertDeliveries.cancelledAt),
        isNull(alertDeliveries.deadLetteredAt),
        sql`${alertDeliveries.expiresAt} > clock_timestamp()`,
        isNotNull(subscribers.confirmedAt),
        isNull(watches.retiredAt),
        eq(watches.activationOrder, alertDeliveries.watchActivationOrder),
      ),
    )
    .limit(1);

  return row
    ? {
        subscriberId: row.subscriberId,
        email: row.email,
        classKey: row.classKey as ClassKey,
        openedAt: row.openedAt.toISOString(),
        reason: row.reason as NotifyReason,
        openSeats: row.openSeats,
        openReserved: row.openReserved,
        createdAt: row.createdAt,
      }
    : undefined;
}

/**
 * Enumerate ready claimed-but-unmarked alerts for cycle-level retry.
 *
 * Email is joined at read time rather than retained in the ledger. Deleting a
 * subscriber cascades its ledger rows, so a retry can never target an account
 * that no longer exists. The finite batch keeps one pathological backlog from
 * monopolizing a poll cycle; successful marks expose later rows next cycle.
 */
export async function listPendingAlertDeliveries(
  db: Db,
  limit = 1_000,
): Promise<PendingAlertDelivery[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError('limit must be a positive integer');
  }

  await db
    .update(alertDeliveries)
    .set({
      deadLetteredAt: sql`clock_timestamp()`,
      terminalAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        isNull(alertDeliveries.sentAt),
        isNull(alertDeliveries.cancelledAt),
        isNull(alertDeliveries.deadLetteredAt),
        lte(alertDeliveries.expiresAt, sql`clock_timestamp()`),
      ),
    );

  const rows = await db
    .select({
      subscriberId: alertDeliveries.subscriberId,
      email: subscribers.email,
      classKey: alertDeliveries.classKey,
      openedAt: alertDeliveries.openedAt,
      reason: alertDeliveries.reason,
      openSeats: alertDeliveries.openSeats,
      openReserved: alertDeliveries.openReserved,
      createdAt: alertDeliveries.createdAt,
    })
    .from(alertDeliveries)
    .innerJoin(subscribers, eq(alertDeliveries.subscriberId, subscribers.id))
    .where(
      and(
        isNull(alertDeliveries.sentAt),
        isNull(alertDeliveries.cancelledAt),
        isNull(alertDeliveries.deadLetteredAt),
        lte(alertDeliveries.nextAttemptAt, sql`now()`),
        sql`${alertDeliveries.expiresAt} > clock_timestamp()`,
      ),
    )
    // Matches alert_deliveries_pending_idx: no backlog-wide sort before LIMIT.
    .orderBy(asc(alertDeliveries.nextAttemptAt), asc(alertDeliveries.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    subscriberId: row.subscriberId,
    email: row.email,
    classKey: row.classKey as ClassKey,
    openedAt: row.openedAt.toISOString(),
    reason: row.reason as NotifyReason,
    openSeats: row.openSeats,
    openReserved: row.openReserved,
    createdAt: row.createdAt,
  }));
}

/**
 * Atomically claim one class transition and its complete confirmed-subscriber
 * fan-out. The conditional class_state update is the transition lock: exactly
 * one worker can replace the prior version. Delivery rows are inserted in the
 * same transaction, before any caller can dispatch them. A crash therefore
 * leaves either the old state and no claims, or the new state and every claim.
 */
export async function claimOpeningDeliveries(
  db: Db,
  opening: OpeningTransitionInput,
): Promise<PendingAlertDelivery[]> {
  const classKey = assertClassKey(opening.classKey);
  assertPersistableOpenSeats(opening.openSeats);
  assertPersistableClassStateCounts(opening.nextState);
  assertPersistableOpenReserved(opening.openSeats, opening.nextState.lastOpenReserved);
  const openedAt = openedAtDate(opening.openedAt);
  const sourceFreshUntil = opening.nextState.sourceFreshUntil ?? new Date(Date.now() + 120 * 1_000);
  if (Number.isNaN(sourceFreshUntil.getTime())) {
    throw new TypeError('sourceFreshUntil must be a valid Date');
  }

  return db.transaction(async (tx) => {
    // Serialize this successful observation against watch activations for the
    // next baseline, without holding the lock during the preceding scrape.
    await lockWatchTableForObservation(tx as unknown as Db);
    // Resolve recipients against the monotonic visibility boundary recorded by
    // the previous successful observation. Wall-clock jumps and equal timestamp
    // values therefore cannot inherit or suppress an opening.
    const targets = await tx
      .select({
        id: subscribers.id,
        email: subscribers.email,
        watchActivationOrder: sql<bigint>`${watches.activationOrder}`,
      })
      .from(watches)
      .innerJoin(subscribers, eq(watches.subscriberId, subscribers.id))
      .where(
        and(
          eq(watches.classKey, classKey),
          isNull(watches.retiredAt),
          isNotNull(watches.activatedAt),
          isNotNull(watches.activationOrder),
          isNotNull(subscribers.confirmedAt),
          sql`${watches.activationOrder} <= (
            select ${classState.observedWatchOrder}
            from ${classState}
            where ${classState.classKey} = ${classKey}
              and ${classState.stateVersion} = ${opening.previousStateVersion}
          )`,
        ),
      );

    const transitioned = await tx
      .update(classState)
      .set({
        lastStatus: opening.nextState.lastStatus,
        lastOpenSeats: opening.nextState.lastOpenSeats,
        lastWaitlistOpen: opening.nextState.lastWaitlistOpen,
        displayName: opening.nextState.displayName,
        lastEnrolled: opening.nextState.lastEnrolled,
        lastCapacity: opening.nextState.lastCapacity,
        lastWaitlisted: opening.nextState.lastWaitlisted,
        lastWaitlistMax: opening.nextState.lastWaitlistMax,
        lastOpenReserved: opening.nextState.lastOpenReserved,
        sourceFreshUntil,
        stateVersion: sql`${classState.stateVersion} + 1`,
        observedWatchOrder: nextWatchVisibilityOrder(),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(classState.classKey, classKey),
          eq(classState.stateVersion, opening.previousStateVersion),
        ),
      )
      .returning();

    // Another worker already consumed this exact state transition.
    if (transitioned.length === 0) return [];

    await cancelDeliveriesClosedByState(tx as unknown as Db, {
      classKey,
      lastOpenSeats: opening.nextState.lastOpenSeats,
      lastWaitlistOpen: opening.nextState.lastWaitlistOpen,
    });

    if (targets.length === 0) return [];

    const claimed = await tx
      .insert(alertDeliveries)
      .values(
        targets.map((target) => ({
          subscriberId: target.id,
          classKey,
          openedAt,
          reason: opening.reason,
          openSeats: opening.openSeats,
          openReserved: opening.nextState.lastOpenReserved,
          watchActivationOrder: target.watchActivationOrder,
          expiresAt: new Date(openedAt.getTime() + MAIL_ALERT_EXPIRY_MS),
          providerIdempotencyKey: legacyAlertIdempotencyKey({
            subscriberId: target.id,
            classKey,
            openedAt,
          }),
        })),
      )
      .returning();

    const createdBySubscriber = new Map(
      claimed.map((row) => [row.subscriberId, row.createdAt] as const),
    );
    return targets.map((target) => ({
      subscriberId: target.id,
      email: target.email,
      classKey,
      openedAt: opening.openedAt,
      reason: opening.reason,
      openSeats: opening.openSeats,
      openReserved: opening.nextState.lastOpenReserved,
      createdAt: createdBySubscriber.get(target.id) ?? openedAt,
    }));
  });
}

// ---------------------------------------------------------------------------
// Unified durable mail outbox (FR-17 / v0.4)
// ---------------------------------------------------------------------------

export type SubscriberMailKind = 'confirmation' | 'manage-link';

export interface MailDispatchJob {
  id: string;
  claimToken: string;
  /**
   * Derived from {@link MAIL_OUTBOX_KINDS} rather than restated, so a new kind
   * cannot land in the schema while this claim shape silently keeps the old
   * union and forces a cast at the dispatcher boundary.
   */
  kind: MailOutboxKind;
  subscriberId: string | null;
  /** Resolved only for the duration of dispatch. PII: never log or persist elsewhere. */
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

export interface MailClaimBatch {
  jobs: MailDispatchJob[];
  /** Jobs terminalized by this claim transaction before provider egress. */
  deadLetteredRetryHorizon: number;
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
  /** Stable classification only (for example `provider_throttled`), never a raw error. */
  errorCode: string;
}

export type MailDeferDisposition =
  | 'claim-fence-lost'
  | 'deferred'
  | 'cancelled-expired'
  | 'dead-lettered-retry-horizon';

export interface ClaimedMailCancellationInput {
  id: string;
  claimToken: string;
  reason: 'suppressed';
}

export interface RetentionSweepResult {
  pendingSubscribers: number;
  terminalMailJobs: number;
  legacyAlertDeliveries: number;
  retiredWatches: number;
  orphanedClassStates: number;
  expiredMailJobs: number;
}

function assertBoundedErrorCode(value: string): string {
  if (!/^[a-z0-9_.:-]{1,128}$/.test(value)) {
    throw new TypeError('errorCode must be a bounded stable classification');
  }
  return value;
}

function assertValidDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return value;
}

/**
 * Queue a subscriber link email without persisting its address or token.
 * Suppression is checked here as an optimization and again at dispatch time.
 */
export async function enqueueSubscriberMail(
  db: Db,
  subscriberId: string,
  kind: SubscriberMailKind,
): Promise<string | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ email: subscribers.email, suppressed: suppressions.email })
      .from(subscribers)
      .leftJoin(suppressions, eq(subscribers.email, suppressions.email))
      .where(eq(subscribers.id, subscriberId))
      .limit(1);
    if (!row || row.suppressed) return undefined;
    return enqueueSubscriberMailInTransaction(tx as unknown as Db, kind, subscriberId);
  });
}

/**
 * Non-enumerating resend primitive. The caller always returns the same HTTP
 * response; this method quietly does nothing for an unknown or suppressed row.
 *
 * One conditional INSERT ... SELECT is the complete persistence operation for
 * every valid address. Known, unknown, and suppressed requests therefore make
 * exactly one database round trip instead of exposing membership through a
 * lookup-only path versus a lookup-then-insert path.
 */
export async function enqueueResendMailByEmail(
  db: Db,
  email: string,
): Promise<{ enqueued: boolean }> {
  const normalized = SubscriberEmailSchema.parse(email);
  const mailJobId = crypto.randomUUID();
  const result = (await db.execute(sql`
    with eligible as (
      select
        ${subscribers.id} as subscriber_id,
        case
          when ${subscribers.confirmedAt} is null then 'confirmation'
          else 'manage-link'
        end as kind
      from ${subscribers}
      where ${subscribers.email} = ${normalized}
        and not exists (
          select 1
          from ${suppressions}
          where ${suppressions.email} = ${subscribers.email}
        )
      limit 1
    )
    insert into ${mailOutbox} (
      "id",
      "kind",
      "subscriber_id",
      "provider_idempotency_key"
    )
    select
      ${mailJobId},
      eligible.kind,
      eligible.subscriber_id,
      'seat-sniper/' || eligible.kind || '/' || ${mailJobId}
    from eligible
    returning "id"
  `)) as unknown as { rows: Array<{ id: string }> };
  return { enqueued: result.rows.length > 0 };
}

/** Queue one suppression-exempt Operator message with bounded template detail. */
export async function enqueueOperatorMail(
  db: Db,
  input: { classKey?: ClassKey; detail: string },
): Promise<string> {
  return enqueueOperatorMailInTransaction(db, input);
}

/**
 * Atomically replace the observed class state and enqueue the complete Alert
 * fan-out. This is the v0.4 successor to the legacy alert-delivery claim path.
 */
export async function commitOpeningAndEnqueueMail(
  db: Db,
  opening: OpeningTransitionInput,
): Promise<OpeningMailCommitResult> {
  const classKey = assertClassKey(opening.classKey);
  assertPersistableOpenSeats(opening.openSeats);
  assertPersistableClassStateCounts(opening.nextState);
  assertPersistableOpenReserved(opening.openSeats, opening.nextState.lastOpenReserved);
  const openedAt = openedAtDate(opening.openedAt);
  const sourceFreshUntil = opening.nextState.sourceFreshUntil ?? new Date(Date.now() + 120 * 1_000);
  assertValidDate(sourceFreshUntil, 'sourceFreshUntil');

  return db.transaction(async (tx) => {
    await lockWatchTableForObservation(tx as unknown as Db);
    const targets = await tx
      .select({
        id: subscribers.id,
      })
      .from(watches)
      .innerJoin(subscribers, eq(watches.subscriberId, subscribers.id))
      .where(
        and(
          eq(watches.classKey, classKey),
          isNull(watches.retiredAt),
          isNotNull(watches.activatedAt),
          isNotNull(watches.activationOrder),
          isNotNull(subscribers.confirmedAt),
          sql`${watches.activationOrder} <= (
            select ${classState.observedWatchOrder}
            from ${classState}
            where ${classState.classKey} = ${classKey}
              and ${classState.stateVersion} = ${opening.previousStateVersion}
          )`,
        ),
      );

    const transitioned = await tx
      .update(classState)
      .set({
        lastStatus: opening.nextState.lastStatus,
        lastOpenSeats: opening.nextState.lastOpenSeats,
        lastWaitlistOpen: opening.nextState.lastWaitlistOpen,
        displayName: opening.nextState.displayName,
        lastEnrolled: opening.nextState.lastEnrolled,
        lastCapacity: opening.nextState.lastCapacity,
        lastWaitlisted: opening.nextState.lastWaitlisted,
        lastWaitlistMax: opening.nextState.lastWaitlistMax,
        lastOpenReserved: opening.nextState.lastOpenReserved,
        sourceFreshUntil,
        stateVersion: sql`${classState.stateVersion} + 1`,
        observedWatchOrder: nextWatchVisibilityOrder(),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(classState.classKey, classKey),
          eq(classState.stateVersion, opening.previousStateVersion),
        ),
      )
      .returning();

    if (transitioned.length === 0) return { transitioned: false, enqueued: 0 };

    await cancelDeliveriesClosedByState(tx as unknown as Db, {
      classKey,
      lastOpenSeats: opening.nextState.lastOpenSeats,
      lastWaitlistOpen: opening.nextState.lastWaitlistOpen,
    });

    if (targets.length === 0) return { transitioned: true, enqueued: 0 };

    const inserted = await tx
      .insert(mailOutbox)
      .values(
        targets.map((target) => ({
          ...outboxIdentity('alert'),
          kind: 'alert' as const,
          subscriberId: target.id,
          classKey,
          openedAt,
          reason: opening.reason,
          expiresAt: new Date(openedAt.getTime() + MAIL_ALERT_EXPIRY_MS),
          payload: {
            openSeats: opening.openSeats,
            openReserved: opening.nextState.lastOpenReserved,
          },
        })),
      )
      .onConflictDoNothing()
      .returning();

    return { transitioned: true, enqueued: inserted.length };
  });
}

/** Outcome of one Blind-window sweep. Counts and class keys only — never PII. */
export interface BlindWindowSweepResult {
  /**
   * Sections that received a NEW disclosure this sweep, sorted and deduped.
   * A Section already disclosed for its current window is absent — it is still
   * blind, it has simply already been reported once, which is the whole rule.
   */
  disclosedSections: ClassKey[];
  /** Disclosure jobs enqueued — one per Subscriber, never more than one per window. */
  enqueued: number;
}

/**
 * Enqueue exactly one Blind-window disclosure per Subscriber per window (FR-28).
 *
 * WHY THE CLOCK IS `class_state.updated_at`
 *   A Blind window is "we could not look," which is far broader than "the parser
 *   broke." Kill switch, the FR-7 safety stop, an unavailable origin fence, a
 *   robots skip, a fetch timeout, a lost lease, and a worker that was simply not
 *   running all blind a Section while writing NO per-Section failure record —
 *   `parser_health` stays absent or healthy throughout. The only signal that
 *   survives every one of those is the ABSENCE of a successful read, and
 *   `class_state.updated_at` records exactly that: it is stamped by a 200 parse
 *   or a trusted 304 and by nothing else (see the `class_state` doc comment).
 *   Measuring from the last success rather than from a first failure is also the
 *   quantity ADR 0010 actually names.
 *
 * WHY THERE IS NO EPISODE TABLE
 *   The two facts this feature needs are already durable. "How long has this
 *   Section been unreadable" is `class_state.updated_at`. "Have we already told
 *   this Subscriber about THIS window" is the existence of the disclosure row
 *   itself, enforced by `mail_outbox_blind_window_logical_uq` on
 *   (subscriber_id, class_key, opened_at) where `opened_at` IS the window start.
 *   Both live in PostgreSQL, so a worker restart recomputes an identical key and
 *   the insert conflicts away instead of emailing a second time, and neither the
 *   elapsed clock nor the already-told fact can be lost with process memory.
 *   Rearming is likewise free: the next successful read moves
 *   `class_state.updated_at`, so a later window carries a different key.
 *
 * The `not exists` filter is an efficiency guard, not the guarantee — it keeps a
 * 30-second poll loop from attempting a doomed insert per watcher per cycle. The
 * unique index is what makes the rule true under concurrent workers.
 *
 * A Section never successfully read has no `class_state` row at all, which is
 * the worst case rather than a benign one: a Watch added while the source is
 * down would otherwise be silently exempt from disclosure forever. Those fall
 * back to `watches.activated_at`, the durable moment the Subscriber began
 * expecting coverage — which is also the floor for every other Watch, so nobody
 * is told about blindness that predates their own interest.
 *
 * Eligibility mirrors the Alert fan-out — live Watch, activated, Confirmed
 * Subscriber (FR-9/FR-13) — and deliberately omits the
 * `activation_order <= observed_watch_order` visibility fence. That fence exists
 * to stop a newly activated Watch inheriting a baseline TRANSITION it never saw;
 * a Blind window is not a transition, and a Subscriber who has been waiting on
 * an unreadable Section is precisely who needs telling.
 */
export async function enqueueBlindWindowDisclosures(
  db: Db,
  options: { now?: Date; windowMs?: number } = {},
): Promise<BlindWindowSweepResult> {
  const windowMs = options.windowMs ?? BLIND_WINDOW_MS;
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new TypeError('blind-window horizon must be a positive whole number of milliseconds');
  }
  const now = options.now ?? new Date();
  assertValidDate(now, 'now');
  const cutoff = new Date(now.getTime() - windowMs);

  // The window start for one watcher: the Section's last successful read, or
  // the moment this Watch went live, whichever is LATER.
  //
  // `greatest`, not `coalesce`. A Subscriber is owed disclosure for the time
  // THEY were relying on us, and a window cannot begin before they had a Watch.
  // `class_state` outlives the Watches that caused it — removing the last Watch
  // on a Section stops it being polled but leaves the row for 90 days — so a
  // stale row is ordinary, not exotic. Under `coalesce` someone adding a Watch
  // on such a Section would be told "we are not watching this, last read three
  // weeks ago" seconds after signing up, for a class the worker reads fine two
  // minutes later. `greatest` gives every Watch the same honest grace period
  // from activation that a never-read Section already gets. PostgreSQL's
  // `greatest` skips NULLs, so a Section with no `class_state` row still falls
  // back to `activated_at`, which the eligibility filter guarantees is non-null.
  //
  // TRUNCATED TO MILLISECONDS deliberately. PostgreSQL keeps microseconds while
  // node-postgres round-trips a Date at millisecond precision (see the
  // `class_state.state_version` comment, which warns about exactly this). Left
  // at full precision, the value we SELECT would be truncated on its way into
  // `opened_at`, and the `not exists` probe below would then compare a truncated
  // stored timestamp against an untruncated live one and never match — the guard
  // would silently do nothing on every cycle forever. Truncating on BOTH sides
  // of the comparison keeps them like-for-like. Two distinct windows for one
  // Watch cannot share a millisecond: they are an hour of blindness apart.
  const windowStartedAt = sql<Date>`date_trunc(
    'milliseconds',
    greatest(${classState.updatedAt}, ${watches.activatedAt})
  )`;

  return db.transaction(async (tx) => {
    const blind = await tx
      .select({
        subscriberId: watches.subscriberId,
        classKey: watches.classKey,
        windowStartedAt: windowStartedAt.mapWith(classState.updatedAt),
      })
      .from(watches)
      .innerJoin(subscribers, eq(subscribers.id, watches.subscriberId))
      .leftJoin(classState, eq(classState.classKey, watches.classKey))
      .where(
        and(
          isNull(watches.retiredAt),
          isNotNull(watches.activatedAt),
          isNotNull(subscribers.confirmedAt),
          sql`${windowStartedAt} <= ${cutoff}`,
          // NOT REQUESTING is not the same as NOT KNOWING. The source scheduler
          // deliberately declines to re-request a Section while the origin's own
          // `Cache-Control` still vouches for the representation it gave us, and
          // it honours a max-age of up to a year (MAX_CACHE_FRESHNESS_SECONDS in
          // src/scraper/fetch.ts). A page served with max-age above an hour would
          // therefore sit unrequested — perfectly healthy, perfectly current, and
          // by elapsed time alone indistinguishable from an outage. Telling four
          // people we had stopped watching a Section we were correctly caching
          // would be a FALSE disclosure, which costs more trust than the silence
          // this feature exists to break.
          //
          // So blindness requires both halves: we have not read it for an hour
          // AND the answer we are holding is no longer source-visibly current.
          // `source_fresh_until` is stamped by the same successful reads that
          // stamp `updated_at`, so it is frozen exactly when we are genuinely
          // blind, and in the ordinary `max-age=0` case it lapses 120 seconds
          // after a read and suppresses nothing. A Section with no `class_state`
          // row at all has never been read, so there is nothing to vouch for it.
          sql`(
            ${classState.sourceFreshUntil} is null
            or ${classState.sourceFreshUntil} <= ${now}
          )`,
          sql`not exists (
            select 1
            from ${mailOutbox}
            where ${mailOutbox.kind} = 'blind-window'
              and ${mailOutbox.subscriberId} = ${watches.subscriberId}
              and ${mailOutbox.classKey} = ${watches.classKey}
              and ${mailOutbox.openedAt} = ${windowStartedAt}
          )`,
        ),
      );

    if (blind.length === 0) return { disclosedSections: [], enqueued: 0 };

    const inserted = await tx
      .insert(mailOutbox)
      .values(
        blind.map((row) => {
          const classKey = assertClassKey(row.classKey);
          return {
            id: crypto.randomUUID(),
            kind: 'blind-window' as const,
            subscriberId: row.subscriberId,
            classKey,
            // Per-kind meaning: the window start, i.e. the last successful read.
            openedAt: row.windowStartedAt,
            // Deterministic, so a concurrent worker collides on the provider key
            // as well as on the logical index. Carries no address or token.
            providerIdempotencyKey: blindWindowIdempotencyKey({
              subscriberId: row.subscriberId,
              classKey,
              windowStartedAt: row.windowStartedAt,
            }),
            // Everything the copy needs is already a column. Keeping the payload
            // empty keeps the PII surface of a retained row at zero.
            payload: {},
          };
        }),
      )
      .onConflictDoNothing()
      // No-argument .returning(): the union `Db` type cannot resolve the
      // columns-argument overload here (same limitation as retireWatchesForClass).
      .returning();

    const disclosedSections = [
      ...new Set(inserted.map((row) => row.classKey).filter((key): key is string => key !== null)),
    ].sort() as ClassKey[];
    return { disclosedSections, enqueued: inserted.length };
  });
}

/** Mark due Alerts terminal before they can be claimed or reclaimed. */
export async function expireMailOutboxAlerts(db: Db): Promise<number> {
  const rows = await db
    .update(mailOutbox)
    .set({
      status: 'cancelled',
      claimedAt: null,
      claimToken: null,
      terminalAt: sql`clock_timestamp()`,
      terminalReason: 'expired',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(mailOutbox.kind, 'alert'),
        inArray(mailOutbox.status, ['queued', 'processing']),
        lte(mailOutbox.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .returning();
  return rows.length;
}

async function openDeadLetterIncidents(
  db: Db,
  jobs: Array<{ id: string; terminalAt: Date | null }>,
): Promise<number> {
  if (jobs.length === 0) return 0;
  const incidentRows = jobs.map((job) => {
    if (!job.terminalAt) {
      throw new Error('dead-letter transition did not return terminal_at');
    }
    return {
      id: crypto.randomUUID(),
      mailJobId: job.id,
      state: 'unresolved' as const,
      openedAt: job.terminalAt,
    };
  });
  const inserted = await db
    .insert(deadLetterIncidents)
    .values(incidentRows)
    .onConflictDoNothing({ target: deadLetterIncidents.mailJobId })
    .returning();
  return inserted.length;
}

async function expireMailOutboxRetryHorizonInTransaction(
  db: Db,
  leaseSeconds: number,
): Promise<number> {
  const rows = await db
    .update(mailOutbox)
    .set({
      status: 'dead_letter',
      claimedAt: null,
      claimToken: null,
      terminalAt: sql`clock_timestamp()`,
      terminalReason: 'retry-horizon',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        sql`${mailOutbox.kind} <> 'alert'`,
        lte(
          mailOutbox.createdAt,
          sql`clock_timestamp() - (${MAIL_RETRY_HORIZON_MS / 1_000} * interval '1 second')`,
        ),
        or(
          eq(mailOutbox.status, 'queued'),
          and(
            eq(mailOutbox.status, 'processing'),
            sql`${mailOutbox.claimedAt} <=
              clock_timestamp() - (${leaseSeconds} * interval '1 second')`,
          ),
        ),
      ),
    )
    .returning();
  await openDeadLetterIncidents(
    db,
    rows.map((row) => ({ id: row.id, terminalAt: row.terminalAt })),
  );
  return rows.length;
}

/**
 * Terminalize non-Alert mail that has reached the provider retry horizon.
 *
 * Queued jobs are no longer eligible to start a send at 23 hours. Processing
 * jobs are terminalized only after their lease is reclaimable; clearing the
 * claim token fences the stale dispatcher from completing or deferring them.
 */
export async function expireMailOutboxRetryHorizon(
  db: Db,
  options: { leaseSeconds?: number } = {},
): Promise<number> {
  const leaseSeconds = options.leaseSeconds ?? 60;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3_600) {
    throw new TypeError('mail claim leaseSeconds must be an integer from 1 to 3600');
  }

  return db.transaction((tx) =>
    expireMailOutboxRetryHorizonInTransaction(tx as unknown as Db, leaseSeconds),
  );
}

/** Cancel an opening that closed before its queued Alert reached the provider. */
export async function cancelOpenAlertMail(
  db: Db,
  classKey: ClassKey,
  reason?: NotifyReason,
): Promise<number> {
  const rows = await db
    .update(mailOutbox)
    .set({
      status: 'cancelled',
      claimedAt: null,
      claimToken: null,
      terminalAt: sql`clock_timestamp()`,
      terminalReason: 'opening-closed',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(mailOutbox.kind, 'alert'),
        eq(mailOutbox.classKey, assertClassKey(classKey)),
        reason ? eq(mailOutbox.reason, reason) : undefined,
        inArray(mailOutbox.status, ['queued', 'processing']),
      ),
    )
    .returning();
  return rows.length;
}

/**
 * Claim a bounded batch with `FOR UPDATE SKIP LOCKED`.
 *
 * The random claim token is an ownership fence. Once a lease expires, another
 * dispatcher may reclaim the row; the stale dispatcher can no longer complete
 * or defer it because its token will not match.
 */
export async function claimMailBatch(
  db: Db,
  options: { limit?: number; leaseSeconds?: number } = {},
): Promise<MailClaimBatch> {
  const limit = options.limit ?? 100;
  const leaseSeconds = options.leaseSeconds ?? 60;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError('mail claim limit must be an integer from 1 to 1000');
  }
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3_600) {
    throw new TypeError('mail claim leaseSeconds must be an integer from 1 to 3600');
  }

  return db.transaction(async (tx) => {
    await expireMailOutboxAlerts(tx as unknown as Db);
    const deadLetteredRetryHorizon = await expireMailOutboxRetryHorizonInTransaction(
      tx as unknown as Db,
      leaseSeconds,
    );

    // A removed/retired watch or de-confirmed subscriber is no longer eligible.
    // Unsubscribe itself cascades the job through subscriber_id. This covers
    // both per-Watch subscriber kinds: an Alert and a Blind-window disclosure
    // (FR-28) are equally undeliverable once the Watch that justified them is
    // gone, and a disclosure has no expiry of its own to retire it.
    await tx
      .update(mailOutbox)
      .set({
        status: 'cancelled',
        claimedAt: null,
        claimToken: null,
        terminalAt: sql`clock_timestamp()`,
        terminalReason: 'subscriber-ineligible',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          inArray(mailOutbox.kind, ['alert', 'blind-window']),
          inArray(mailOutbox.status, ['queued', 'processing']),
          sql`not exists (
            select 1
            from ${watches}
            inner join ${subscribers}
              on ${subscribers.id} = ${watches.subscriberId}
            where ${watches.subscriberId} = ${mailOutbox.subscriberId}
              and ${watches.classKey} = ${mailOutbox.classKey}
              and ${watches.retiredAt} is null
              and ${subscribers.confirmedAt} is not null
          )`,
        ),
      );

    const candidates = await tx
      .select({ id: mailOutbox.id })
      .from(mailOutbox)
      .where(
        or(
          and(eq(mailOutbox.status, 'queued'), lte(mailOutbox.availableAt, sql`clock_timestamp()`)),
          and(
            eq(mailOutbox.status, 'processing'),
            sql`${mailOutbox.claimedAt} <=
              clock_timestamp() - (${leaseSeconds} * interval '1 second')`,
          ),
        ),
      )
      .orderBy(asc(mailOutbox.availableAt), asc(mailOutbox.createdAt))
      .limit(limit)
      .for('update', { skipLocked: true });

    if (candidates.length === 0) {
      return { jobs: [], deadLetteredRetryHorizon };
    }

    const ids = candidates.map((row) => row.id);
    const claimToken = crypto.randomUUID();
    await tx
      .update(mailOutbox)
      .set({
        status: 'processing',
        attempts: sql`${mailOutbox.attempts} + 1`,
        claimedAt: sql`clock_timestamp()`,
        claimToken,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(inArray(mailOutbox.id, ids));

    const rows = await tx
      .select({
        id: mailOutbox.id,
        claimToken: mailOutbox.claimToken,
        kind: mailOutbox.kind,
        subscriberId: mailOutbox.subscriberId,
        email: subscribers.email,
        confirmedAt: subscribers.confirmedAt,
        classKey: mailOutbox.classKey,
        openedAt: mailOutbox.openedAt,
        reason: mailOutbox.reason,
        attempts: mailOutbox.attempts,
        expiresAt: mailOutbox.expiresAt,
        providerIdempotencyKey: mailOutbox.providerIdempotencyKey,
        payload: mailOutbox.payload,
        createdAt: mailOutbox.createdAt,
      })
      .from(mailOutbox)
      .leftJoin(subscribers, eq(mailOutbox.subscriberId, subscribers.id))
      .where(and(inArray(mailOutbox.id, ids), eq(mailOutbox.claimToken, claimToken)))
      .orderBy(asc(mailOutbox.availableAt), asc(mailOutbox.createdAt));

    const jobs = rows.map((row) => ({
      id: row.id,
      claimToken: row.claimToken as string,
      kind: row.kind,
      subscriberId: row.subscriberId,
      email: row.email,
      subscriberConfirmed: row.subscriberId === null ? null : row.confirmedAt !== null,
      classKey: row.classKey as ClassKey | null,
      openedAt: row.openedAt,
      reason: row.reason as NotifyReason | null,
      attempts: row.attempts,
      expiresAt: row.expiresAt,
      providerIdempotencyKey: row.providerIdempotencyKey,
      payload: row.payload,
      createdAt: row.createdAt,
    }));
    return { jobs, deadLetteredRetryHorizon };
  });
}

/** Compatibility convenience for callers that need only the claimed jobs. */
export async function claimMailJobs(
  db: Db,
  options: { limit?: number; leaseSeconds?: number } = {},
): Promise<MailDispatchJob[]> {
  return (await claimMailBatch(db, options)).jobs;
}

/** Mark success only while the caller still owns the claim token. */
export async function completeMailJob(db: Db, input: MailCompletionInput): Promise<boolean> {
  const providerAcceptedAt = input.providerAcceptedAt ?? new Date();
  assertValidDate(providerAcceptedAt, 'providerAcceptedAt');
  if (input.providerMessageId && input.providerMessageId.length > 512) {
    throw new TypeError('providerMessageId must be at most 512 characters');
  }

  const rows = await db
    .update(mailOutbox)
    .set({
      status: 'sent',
      claimedAt: null,
      claimToken: null,
      sentAt: providerAcceptedAt,
      terminalAt: sql`clock_timestamp()`,
      providerMessageId: input.providerMessageId,
      providerAcceptedAt,
      lastErrorCode: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(mailOutbox.id, input.id),
        eq(mailOutbox.status, 'processing'),
        eq(mailOutbox.claimToken, input.claimToken),
      ),
    )
    .returning();
  return rows.length > 0;
}

/**
 * Make a suppression-withheld delivery terminal without classifying it as an
 * operator-actionable provider failure. The claim token fences this update
 * against a lease expiry/reclaim race.
 */
export async function cancelClaimedMailJob(
  db: Db,
  input: ClaimedMailCancellationInput,
): Promise<boolean> {
  const rows = await db
    .update(mailOutbox)
    .set({
      status: 'cancelled',
      claimedAt: null,
      claimToken: null,
      terminalAt: sql`clock_timestamp()`,
      terminalReason: input.reason,
      lastErrorCode: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(mailOutbox.id, input.id),
        eq(mailOutbox.status, 'processing'),
        eq(mailOutbox.claimToken, input.claimToken),
      ),
    )
    .returning();
  return rows.length > 0;
}

/**
 * Release a failed claim back to the queue, or make it terminal when the next
 * attempt would cross the Alert expiry/provider idempotency horizon.
 */
export async function deferMailJob(db: Db, input: MailDeferInput): Promise<MailDeferDisposition> {
  const availableAt = assertValidDate(input.availableAt, 'availableAt');
  const errorCode = assertBoundedErrorCode(input.errorCode);

  return db.transaction(async (tx) => {
    const [job] = await tx
      .select({
        kind: mailOutbox.kind,
        createdAt: mailOutbox.createdAt,
        expiresAt: mailOutbox.expiresAt,
      })
      .from(mailOutbox)
      .where(
        and(
          eq(mailOutbox.id, input.id),
          eq(mailOutbox.status, 'processing'),
          eq(mailOutbox.claimToken, input.claimToken),
        ),
      )
      .for('update')
      .limit(1);
    if (!job) return 'claim-fence-lost';

    const retryDeadline =
      job.kind === 'alert' && job.expiresAt
        ? job.expiresAt
        : new Date(job.createdAt.getTime() + MAIL_RETRY_HORIZON_MS);
    const terminal =
      availableAt.getTime() >= retryDeadline.getTime() || Date.now() >= retryDeadline.getTime();

    const rows = await tx
      .update(mailOutbox)
      .set(
        terminal
          ? {
              status: job.kind === 'alert' ? 'cancelled' : 'dead_letter',
              claimedAt: null,
              claimToken: null,
              terminalAt: sql`clock_timestamp()`,
              terminalReason: job.kind === 'alert' ? 'expired' : 'retry-horizon',
              lastErrorCode: errorCode,
              updatedAt: sql`clock_timestamp()`,
            }
          : {
              status: 'queued',
              claimedAt: null,
              claimToken: null,
              availableAt,
              lastErrorCode: errorCode,
              updatedAt: sql`clock_timestamp()`,
            },
      )
      .where(
        and(
          eq(mailOutbox.id, input.id),
          eq(mailOutbox.status, 'processing'),
          eq(mailOutbox.claimToken, input.claimToken),
        ),
      )
      .returning();
    if (rows.length === 0) return 'claim-fence-lost';
    if (!terminal) return 'deferred';
    if (job.kind !== 'alert') {
      await openDeadLetterIncidents(
        tx as unknown as Db,
        rows.map((row) => ({ id: row.id, terminalAt: row.terminalAt })),
      );
    }
    return job.kind === 'alert' ? 'cancelled-expired' : 'dead-lettered-retry-horizon';
  });
}

/** Permanently fail a claimed job; intended for classified non-retryable errors. */
export async function deadLetterMailJob(
  db: Db,
  input: { id: string; claimToken: string; errorCode: string },
): Promise<boolean> {
  const errorCode = assertBoundedErrorCode(input.errorCode);
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(mailOutbox)
      .set({
        status: 'dead_letter',
        claimedAt: null,
        claimToken: null,
        terminalAt: sql`clock_timestamp()`,
        terminalReason: 'permanent-failure',
        lastErrorCode: errorCode,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(mailOutbox.id, input.id),
          eq(mailOutbox.status, 'processing'),
          eq(mailOutbox.claimToken, input.claimToken),
        ),
      )
      .returning();
    if (rows.length === 0) return false;
    await openDeadLetterIncidents(
      tx as unknown as Db,
      rows.map((row) => ({ id: row.id, terminalAt: row.terminalAt })),
    );
    return true;
  });
}

export interface DeadLetterIncidentSurfaceClaim {
  id: string;
  mailJobId: string;
  /** Stable retry key for the operational sink; never a mail-outbox key. */
  idempotencyKey: string;
  mailKind: MailOutboxKind;
  terminalReason: MailOutboxTerminalReason;
  lastErrorCode: string | null;
  state: DeadLetterIncidentState;
  openedAt: Date;
}

/**
 * Claim a bounded set of incidents whose operational event is not yet marked
 * accepted. The transaction holds row locks only while selecting; the caller
 * publishes after it returns and relies on the stable incident idempotency key
 * across crash/retry or overlapping failover. No recipient, payload, token, or
 * follow-on mail work is exposed.
 */
export async function claimDeadLetterIncidentsForSurface(
  db: Db,
  options: { limit?: number } = {},
): Promise<DeadLetterIncidentSurfaceClaim[]> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError('dead-letter incident claim limit must be an integer from 1 to 1000');
  }

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: deadLetterIncidents.id,
        mailJobId: deadLetterIncidents.mailJobId,
        mailKind: mailOutbox.kind,
        terminalReason: mailOutbox.terminalReason,
        lastErrorCode: mailOutbox.lastErrorCode,
        state: deadLetterIncidents.state,
        openedAt: deadLetterIncidents.openedAt,
      })
      .from(deadLetterIncidents)
      .innerJoin(mailOutbox, eq(deadLetterIncidents.mailJobId, mailOutbox.id))
      .where(and(isNull(deadLetterIncidents.surfacedAt), eq(mailOutbox.status, 'dead_letter')))
      .orderBy(asc(deadLetterIncidents.openedAt), asc(deadLetterIncidents.id))
      .limit(limit)
      .for('update', { skipLocked: true });

    return rows.map((row) => {
      if (!row.terminalReason) {
        throw new Error('dead-letter incident references a job without terminal_reason');
      }
      return {
        id: row.id,
        mailJobId: row.mailJobId,
        idempotencyKey: `dead-letter/${row.id}`,
        mailKind: row.mailKind,
        terminalReason: row.terminalReason,
        lastErrorCode: row.lastErrorCode,
        state: row.state,
        openedAt: row.openedAt,
      };
    });
  });
}

/**
 * Stamp external acceptance once. False means another publisher already
 * recorded success or the incident no longer exists; retries must continue to
 * use the claim's stable idempotency key until this returns true/was stamped.
 */
export async function markDeadLetterIncidentSurfaced(
  db: Db,
  input: { id: string; surfacedAt?: Date },
): Promise<boolean> {
  const surfacedAt = assertValidDate(input.surfacedAt ?? new Date(), 'surfacedAt');
  const rows = await db
    .update(deadLetterIncidents)
    .set({ surfacedAt })
    .where(and(eq(deadLetterIncidents.id, input.id), isNull(deadLetterIncidents.surfacedAt)))
    .returning();
  return rows.length > 0;
}

/** Explicit Operator ownership; only the unresolved → acknowledged edge mutates. */
export async function acknowledgeDeadLetterIncident(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(deadLetterIncidents)
    .set({
      state: 'acknowledged',
      acknowledgedAt: sql`clock_timestamp()`,
    })
    .where(and(eq(deadLetterIncidents.id, id), eq(deadLetterIncidents.state, 'unresolved')))
    .returning();
  return rows.length > 0;
}

/**
 * Explicit Operator resolution. Direct unresolved → resolved and
 * acknowledged → resolved are both valid; no replay or job update calls this
 * implicitly.
 */
export async function resolveDeadLetterIncident(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(deadLetterIncidents)
    .set({
      state: 'resolved',
      resolvedAt: sql`clock_timestamp()`,
    })
    .where(and(eq(deadLetterIncidents.id, id), sql`${deadLetterIncidents.state} <> 'resolved'`))
    .returning();
  return rows.length > 0;
}

export interface MailOutboxHealth {
  queued: number;
  processing: number;
  deadLetter: number;
  oldestQueuedAt: Date | null;
}

/**
 * Minimal aggregate used by readiness/metrics; contains no recipient data.
 * `deadLetter` is the compatibility field name for unresolved incident count:
 * acknowledged/resolved incidents do not fail aggregate readiness.
 */
export async function getMailOutboxHealth(db: Db): Promise<MailOutboxHealth> {
  const result = (await db.execute(sql`
    select
      count(*) filter (where status = 'queued')::int as queued,
      count(*) filter (where status = 'processing')::int as processing,
      (
        select count(*)::int
        from ${deadLetterIncidents}
        where ${deadLetterIncidents.state} = 'unresolved'
      ) as dead_letter,
      min(created_at) filter (where status = 'queued') as oldest_queued_at
    from ${mailOutbox}
  `)) as unknown as {
    rows: Array<{
      queued: number;
      processing: number;
      dead_letter: number;
      oldest_queued_at: Date | string | null;
    }>;
  };
  const row = result.rows[0];
  return {
    queued: Number(row?.queued ?? 0),
    processing: Number(row?.processing ?? 0),
    deadLetter: Number(row?.dead_letter ?? 0),
    oldestQueuedAt: row?.oldest_queued_at ? new Date(row.oldest_queued_at) : null,
  };
}

/**
 * Execute bounded-retention policy in one transaction. Suppressions are
 * intentionally absent: deliverability state survives account churn.
 */
export async function sweepRetention(db: Db, now = new Date()): Promise<RetentionSweepResult> {
  assertValidDate(now, 'now');
  const pendingCutoff = new Date(now.getTime() - PENDING_SUBSCRIBER_RETENTION_MS);
  const terminalCutoff = new Date(now.getTime() - TERMINAL_RETENTION_MS);

  return db.transaction(async (tx) => {
    // Match create/delete lock ordering before a cascading subscriber purge.
    await lockWatchTableForActivation(tx as unknown as Db);
    const expiredMailJobs = await expireMailOutboxAlerts(tx as unknown as Db);

    await tx
      .update(mailOutbox)
      .set({
        subscriberId: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(mailOutbox.status, 'dead_letter'),
          sql`${mailOutbox.subscriberId} in (
            select ${subscribers.id}
            from ${subscribers}
            where ${subscribers.confirmedAt} is null
              and ${subscribers.createdAt} <= ${pendingCutoff}
          )`,
          sql`exists (
            select 1
            from ${deadLetterIncidents}
            where ${deadLetterIncidents.mailJobId} = ${mailOutbox.id}
              and ${deadLetterIncidents.state} in ('unresolved', 'acknowledged')
          )`,
        ),
      );

    const removedPending = await tx
      .delete(subscribers)
      .where(and(isNull(subscribers.confirmedAt), lte(subscribers.createdAt, pendingCutoff)))
      .returning();

    const removedMail = await tx
      .delete(mailOutbox)
      .where(
        and(
          inArray(mailOutbox.status, ['sent', 'cancelled', 'dead_letter']),
          lte(mailOutbox.terminalAt, terminalCutoff),
          sql`not exists (
            select 1
            from ${deadLetterIncidents}
            where ${deadLetterIncidents.mailJobId} = ${mailOutbox.id}
              and ${deadLetterIncidents.state} in ('unresolved', 'acknowledged')
          )`,
        ),
      )
      .returning();

    const removedLegacy = await tx
      .delete(alertDeliveries)
      .where(lte(alertDeliveries.terminalAt, terminalCutoff))
      .returning();

    const removedWatches = await tx
      .delete(watches)
      .where(and(isNotNull(watches.retiredAt), lte(watches.retiredAt, terminalCutoff)))
      .returning();

    const removedStates = await tx
      .delete(classState)
      .where(
        and(
          lte(classState.updatedAt, terminalCutoff),
          sql`not exists (
            select 1 from ${watches}
            where ${watches.classKey} = ${classState.classKey}
          )`,
          sql`not exists (
            select 1 from ${mailOutbox}
            where ${mailOutbox.classKey} = ${classState.classKey}
          )`,
          sql`not exists (
            select 1 from ${alertDeliveries}
            where ${alertDeliveries.classKey} = ${classState.classKey}
          )`,
        ),
      )
      .returning();

    return {
      pendingSubscribers: removedPending.length,
      terminalMailJobs: removedMail.length,
      legacyAlertDeliveries: removedLegacy.length,
      retiredWatches: removedWatches.length,
      orphanedClassStates: removedStates.length,
      expiredMailJobs,
    };
  });
}

// ---------------------------------------------------------------------------
// Suppression operations (FR-12 / D4-D5)
// ---------------------------------------------------------------------------

/**
 * Suppress an email ADDRESS so the notifier never sends it any subscriber-facing
 * mail (alert, confirmation, manage-link) again (FR-12 / AC-13). Operator mail is
 * exempt (it is internal, not subscriber-facing).
 *
 * Idempotent and first-reason-wins: INSERT … ON CONFLICT (email) DO NOTHING —
 * once an address is suppressed it stays suppressed regardless of a later signal
 * (a complaint after a bounce, etc.), so the stored reason is the first one seen.
 * Keyed on the address (not a subscriber id) so suppression survives
 * unsubscribe/re-subscribe (spec §5).
 *
 * PII: `email` is never logged here or by callers — log counts only (AC-8).
 * The caller passes a normalized address (EmailSchema-validated upstream, e.g.
 * via suppressionsFromResendEvent); this layer does not re-validate.
 */
export async function suppressEmail(
  db: Db,
  email: string,
  reason: SuppressionReason,
): Promise<void> {
  await db
    .insert(suppressions)
    .values({ email: EmailSchema.parse(email), reason })
    .onConflictDoNothing();
}

/**
 * Return true if an email ADDRESS is suppressed (FR-12). The notifier calls this
 * before EVERY subscriber-facing send; a suppressed address gets nothing.
 *
 * Uses the suppressions primary-key (email) index — O(1) lookup.
 * PII: never log the address (AC-8).
 */
export async function isSuppressed(db: Db, email: string): Promise<boolean> {
  const normalized = EmailSchema.parse(email);
  const [row] = await db
    .select({ email: suppressions.email })
    .from(suppressions)
    .where(eq(suppressions.email, normalized))
    .limit(1);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Push-subscription operations (FR-15 / D10)
// ---------------------------------------------------------------------------

/** A push subscription as the notifier needs it to dispatch one Alert: the
 * endpoint + keys for `web-push`. Delivery credentials — NEVER log endpoint or
 * keys (constitution / AC-8); log opaque ids + counts only. */
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: PushKeys;
}

/** v0.3.3 abuse/storage bound (spec §6). */
export const MAX_PUSH_SUBSCRIPTIONS_PER_SUBSCRIBER = 5;

/** Count browsers currently owned by one subscriber. */
export async function countPushSubscriptions(db: Db, subscriberId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.subscriberId, subscriberId));
  return row?.value ?? 0;
}

/**
 * Register (or re-register) THIS browser for alert push (FR-15 / AC-16 / spec §4).
 *
 * Idempotent upsert keyed on the GLOBALLY-UNIQUE `endpoint`:
 *   - new endpoint                         → insert.
 *   - same endpoint, same/other subscriber → update keys AND reassign the row to
 *     the caller's subscriber (last write wins — the browser belongs to whoever
 *     holds the token and the device, spec §4).
 *
 * Accepted even when VAPID is unconfigured (the row is inert until keys exist).
 * The caller must have verified the subscriber is CONFIRMED (the 409-while-Pending
 * gate is a backend concern; this layer just persists). Delivery credentials are
 * never logged.
 */
export async function upsertPushSubscription(
  db: Db,
  subscriberId: string,
  endpoint: string,
  keys: PushKeys,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize registrations for one target subscriber. A route-level count
    // alone has a TOCTOU race; locking the stable subscriber row makes the cap
    // hold even when multiple endpoints are enabled concurrently.
    const lockedSubscriber = await tx
      .select({ id: subscribers.id })
      .from(subscribers)
      .where(eq(subscribers.id, subscriberId))
      .for('update');
    if (lockedSubscriber.length === 0) {
      throw new SubscriberNotFoundError(subscriberId);
    }

    const [existing] = await tx
      .select({ subscriberId: pushSubscriptions.subscriberId })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .limit(1);

    // Refreshing an endpoint already owned by this subscriber does not consume
    // another slot. New endpoints and last-write-wins reassignments do.
    if (existing?.subscriberId !== subscriberId) {
      const [owned] = await tx
        .select({ value: count() })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.subscriberId, subscriberId));
      if ((owned?.value ?? 0) >= MAX_PUSH_SUBSCRIPTIONS_PER_SUBSCRIBER) {
        throw new PushSubscriptionLimitError(subscriberId);
      }
    }

    await tx
      .insert(pushSubscriptions)
      .values({ subscriberId, endpoint, p256dh: keys.p256dh, auth: keys.auth })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          // Reassign to the registering subscriber + refresh keys (last write wins).
          subscriberId,
          p256dh: keys.p256dh,
          auth: keys.auth,
        },
      });
  });
}

/**
 * Deregister a browser by its `endpoint` (FR-15 / spec §4). Idempotent — an
 * unknown endpoint is a no-op (the DELETE route still returns 204). Used both by
 * the manage-view disable toggle and by the notifier's 404/410 cleanup when the
 * push service reports a subscription is gone (spec §5).
 *
 * Returns the number of rows deleted (0 or 1) — count only, never log the
 * endpoint (AC-8).
 */
export async function deletePushSubscription(db: Db, endpoint: string): Promise<number> {
  // No-argument .returning(): the union `Db` type cannot resolve the
  // columns-argument overload here; we only need the count of deleted rows.
  const deleted = await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .returning();
  return deleted.length;
}

/**
 * Delete a browser only when it belongs to the authenticated subscriber.
 *
 * This is the user-facing disable primitive. Keep `deletePushSubscription`
 * above as the trusted global cleanup used after a push service returns 404/410.
 * Both are idempotent and expose only a row count.
 */
export async function deletePushSubscriptionForSubscriber(
  db: Db,
  subscriberId: string,
  endpoint: string,
): Promise<number> {
  const deleted = await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.subscriberId, subscriberId),
        eq(pushSubscriptions.endpoint, endpoint),
      ),
    )
    .returning();
  return deleted.length;
}

/**
 * Prune a gone endpoint only when ownership and both browser keys still match
 * the delivery snapshot. A 404/410 response can race a re-registration; that
 * stale response must not delete the newly assigned or refreshed subscription.
 */
export async function deletePushSubscriptionIfMatches(
  db: Db,
  subscriberId: string,
  target: PushSubscriptionRecord,
): Promise<number> {
  const deleted = await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.subscriberId, subscriberId),
        eq(pushSubscriptions.endpoint, target.endpoint),
        eq(pushSubscriptions.p256dh, target.keys.p256dh),
        eq(pushSubscriptions.auth, target.keys.auth),
      ),
    )
    .returning();
  return deleted.length;
}

/**
 * List a subscriber's registered browsers for push fan-out (FR-15 / AC-16).
 * The notifier gathers these to push one Alert to each browser after an email.
 *
 * Returns endpoint + keys per row. Delivery credentials — NEVER log them
 * (constitution / AC-8). Uses the push_subscriptions_subscriber_idx index.
 */
export async function listPushSubscriptions(
  db: Db,
  subscriberId: string,
): Promise<PushSubscriptionRecord[]> {
  const rows = await db
    .select({
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.subscriberId, subscriberId));

  return rows.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
}
