import { and, eq, sql } from 'drizzle-orm';
import type { ClassKey } from '../shared/class-key';
import { ClassKeySchema } from '../shared/class-key';
import type { SeatStatus } from '../shared/seat-state';
import type { Db } from './client';
import { classState, subscribers, watches } from './schema';

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
  // Email is stored here for server-side logging of the conflict event.
  // NEVER include email in the client-facing error response (constitution / AC-8).
  readonly email: string;

  constructor(email: string) {
    super('subscriber email already registered');
    this.name = 'DuplicateSubscriberError';
    this.email = email;
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
 * Fetch the current watch list for a subscriber as an array of ClassKey.
 * Internal helper — avoids duplicating the query across addWatch, removeWatch,
 * and createSubscriberWithWatches. Each classKey was validated before insert;
 * the cast to ClassKey is safe.
 */
async function fetchWatchList(db: Db, subscriberId: string): Promise<ClassKey[]> {
  const rows = await db
    .select({ classKey: watches.classKey })
    .from(watches)
    .where(eq(watches.subscriberId, subscriberId));
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
): Promise<{ subscriberId: string; watches: ClassKey[] }> {
  // Validate and de-dupe class keys at the boundary before touching the DB.
  const validatedKeys = [...new Set(classKeys.map(assertClassKey))];

  return await db.transaction(async (tx) => {
    // Insert-only: throw DuplicateSubscriberError on email conflict rather than
    // merging into an existing subscription. This prevents account-takeover via
    // unauthenticated create (spec §4 / AC-2b).
    let subscriberId: string;
    try {
      // Use the no-argument .returning() form (returns all columns) to avoid
      // a TypeScript overload resolution issue with the union Db type inside
      // a transaction callback. We pick only `id` from the result.
      const [subscriber] = await tx.insert(subscribers).values({ email }).returning();
      subscriberId = subscriber.id;
    } catch (err) {
      // drizzle 0.45 wraps the driver error; walk the cause chain for SQLSTATE
      // 23505. The only unique constraint on subscribers is `subscribers_email_unique`
      // so any 23505 here is a duplicate email.
      if (uniqueViolationConstraint(err) !== undefined) {
        throw new DuplicateSubscriberError(email);
      }
      throw err;
    }

    // Insert all watches. Duplicate keys within the set are already removed;
    // onConflictDoNothing is a belt-and-suspenders guard for races only.
    if (validatedKeys.length > 0) {
      await tx
        .insert(watches)
        .values(validatedKeys.map((classKey) => ({ subscriberId, classKey })))
        .onConflictDoNothing();
    }

    const currentWatches = await fetchWatchList(tx as unknown as Db, subscriberId);
    return { subscriberId, watches: currentWatches };
  });
}

/**
 * Look up a subscriber by their opaque id.
 * Returns undefined if no row exists.
 * Never log the returned email (constitution / AC-8).
 */
export async function getSubscriberById(
  db: Db,
  id: string,
): Promise<{ id: string; email: string; createdAt: Date } | undefined> {
  const [row] = await db.select().from(subscribers).where(eq(subscribers.id, id)).limit(1);
  return row ? { id: row.id, email: row.email, createdAt: row.createdAt } : undefined;
}

/**
 * Look up a subscriber by their email address.
 * Returns undefined if no row exists.
 * Never log the returned email (constitution / AC-8).
 */
export async function getSubscriberByEmail(
  db: Db,
  email: string,
): Promise<{ id: string; email: string; createdAt: Date } | undefined> {
  const [row] = await db.select().from(subscribers).where(eq(subscribers.email, email)).limit(1);
  return row ? { id: row.id, email: row.email, createdAt: row.createdAt } : undefined;
}

/**
 * Add one watch for a subscriber.
 *
 * Returns the full updated watch list on success.
 * Throws DuplicateWatchError when (subscriber_id, class_key) already exists —
 * the backend catches this and maps it to 409 conflict.
 *
 * classKey is validated with ClassKeySchema at the boundary.
 */
export async function addWatch(
  db: Db,
  subscriberId: string,
  classKey: ClassKey,
): Promise<ClassKey[]> {
  const validatedKey = assertClassKey(classKey);

  try {
    await db.insert(watches).values({ subscriberId, classKey: validatedKey });
  } catch (err) {
    // drizzle 0.45 wraps the driver error; walk the cause chain for SQLSTATE
    // 23505. Disambiguate by constraint name: watches_subscriber_class_uq is
    // the only unique constraint on watches. Any other 23505 is re-thrown.
    const constraint = uniqueViolationConstraint(err);
    if (constraint === 'watches_subscriber_class_uq') {
      throw new DuplicateWatchError(subscriberId, validatedKey);
    }
    if (constraint !== undefined) {
      // Unexpected unique violation on watches — re-throw as-is.
      throw err;
    }
    throw err;
  }

  return fetchWatchList(db, subscriberId);
}

/**
 * Remove one watch for a subscriber.
 *
 * Idempotent — no error if the watch does not exist.
 * Returns the full updated watch list.
 */
export async function removeWatch(
  db: Db,
  subscriberId: string,
  classKey: ClassKey,
): Promise<ClassKey[]> {
  const validatedKey = assertClassKey(classKey);

  await db
    .delete(watches)
    .where(and(eq(watches.subscriberId, subscriberId), eq(watches.classKey, validatedKey)));

  return fetchWatchList(db, subscriberId);
}

/**
 * Delete a subscriber and cascade to their watches.
 *
 * Idempotent — no error if the subscriber does not exist.
 * FK onDelete: 'cascade' removes all their watch rows automatically.
 */
export async function deleteSubscriber(db: Db, id: string): Promise<void> {
  await db.delete(subscribers).where(eq(subscribers.id, id));
}

/**
 * List the canonical class keys currently watched by a subscriber.
 */
export async function listWatches(db: Db, subscriberId: string): Promise<ClassKey[]> {
  return fetchWatchList(db, subscriberId);
}

// ---------------------------------------------------------------------------
// Worker fan-out operations
// ---------------------------------------------------------------------------

/**
 * Return all distinct class keys currently watched by at least one subscriber.
 * The poller calls this once per cycle to build its fetch queue (FR-3).
 *
 * Uses the watches_class_key_idx index.
 */
export async function getDistinctWatchedClassKeys(db: Db): Promise<ClassKey[]> {
  const rows = await db.selectDistinct({ classKey: watches.classKey }).from(watches);
  return rows.map((r) => r.classKey as ClassKey);
}

/**
 * Return all subscribers watching a given class key.
 * Used by the worker to fan out notifications after a seat transition (FR-4).
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
    .where(eq(watches.classKey, validatedKey));
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
  },
): Promise<void> {
  const validatedKey = assertClassKey(state.classKey);

  await db
    .insert(classState)
    .values({
      classKey: validatedKey,
      lastStatus: state.lastStatus,
      lastOpenSeats: state.lastOpenSeats,
      lastWaitlistOpen: state.lastWaitlistOpen,
    })
    .onConflictDoUpdate({
      target: classState.classKey,
      set: {
        lastStatus: state.lastStatus,
        lastOpenSeats: state.lastOpenSeats,
        lastWaitlistOpen: state.lastWaitlistOpen,
        updatedAt: sql`now()`,
      },
    });
}
