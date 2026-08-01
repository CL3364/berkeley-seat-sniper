/**
 * Binding adapter — wraps the db-lane repo functions (which take `db` as a
 * first argument for testability) into a bound object that satisfies the
 * `SubscriptionRepo` interface declared in `src/server/app.ts`.
 *
 * The adapter lives in the db lane because it is a db concern: it knows which
 * repo functions to bind and how to translate their return shapes. The server
 * lane calls `makeRepo(getDb())` in `src/server/index.ts` and passes the result
 * to `createApp(repo)`.
 *
 * Error translation: my repo throws `DuplicateSubscriberError` and
 * `DuplicateWatchError`. The server's `mapRepoError` checks for these by name
 * (`.name` property) rather than by class identity to avoid cross-module
 * instanceof brittleness. No ConflictError / NotFoundError wrapping here —
 * the errors propagate as-is; the server narrows them.
 */

import type { PushKeys, SuppressionReason, WatchFreshness } from '../shared/api';
import type { ClassKey } from '../shared/class-key';
import type { Db } from './client';
import {
  addWatchWithFreshness,
  cancelClaimedMailJob,
  confirmSubscriber,
  countPushSubscriptions,
  createSubscriberWithWatches,
  countDistinctLiveClassKeys,
  deletePushSubscriptionForSubscriber,
  deleteSubscriber,
  enqueueResendMailByEmail,
  enqueueSubscriberMail,
  getSubscriberById,
  hasLiveWatchForClass,
  isSuppressed,
  listWatchFreshness,
  removeWatch,
  suppressEmail,
  upsertPushSubscription,
} from './repo';
import type {
  CapacityAdmissionOptions,
  ClaimedMailCancellationInput,
  SubscriberMailKind,
  WatchFreshnessRecord,
} from './repo';

/**
 * Minimal subscriber record shape expected by the server route handlers.
 *
 * `confirmed` realizes the Pending/Confirmed state for the contract's
 * GetSubscriptionResponse (`confirmed: boolean`) and gates push registration
 * (409 while Pending, FR-15). Derived from `confirmed_at IS NOT NULL`.
 */
export interface SubscriberRecord {
  id: string;
  email: string;
  confirmed: boolean;
  watches: ClassKey[];
  watchFreshness: WatchFreshness[];
}

/**
 * Bound repo interface — structurally compatible with SubscriptionRepo in
 * src/server/app.ts. Defined here so the server can import the type without
 * creating a cross-lane dependency.
 */
export interface BoundRepo {
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

  // --- v0.3 additions (double opt-in, suppression, push) -------------------

  /**
   * Confirm a subscriber (Pending → Confirmed), idempotently (FR-9 / AC-10).
   * The first transition atomically activates every staged live Watch subject
   * to Confirmed unique-Section capacity. Already-confirmed skips capacity and
   * preserves every timestamp/order.
   */
  confirmSubscriber(id: string): Promise<'confirmed' | 'already_confirmed' | 'capacity_exceeded'>;

  /** True iff an email address is suppressed (FR-12). Checked before any
   * subscriber-facing send. Never log the address. */
  isSuppressed(email: string): Promise<boolean>;

  /** Suppress an email address (idempotent, first-reason-wins, FR-12). Keyed on
   * the address — survives unsubscribe/re-subscribe. Never log the address. */
  suppressEmail(email: string, reason: SuppressionReason): Promise<void>;

  /** Upsert a browser push registration keyed on the globally-unique endpoint;
   * reassigns to this subscriber on conflict (last write wins, FR-15). The
   * backend gates on Confirmed before calling. Delivery creds: never log. */
  upsertPushSubscription(subscriberId: string, endpoint: string, keys: PushKeys): Promise<void>;

  /** Count this subscriber's registered browsers (v0.3.3 cap support). */
  countPushSubscriptions(subscriberId: string): Promise<number>;

  /** Delete only a push registration owned by this subscriber (idempotent). */
  deletePushSubscriptionForSubscriber(subscriberId: string, endpoint: string): Promise<number>;

  enqueueSubscriberMail(
    subscriberId: string,
    kind: SubscriberMailKind,
  ): Promise<string | undefined>;
  enqueueResendMailByEmail(email: string): Promise<{ enqueued: boolean }>;
  cancelClaimedMailJob(input: ClaimedMailCancellationInput): Promise<boolean>;
  countDistinctLiveClassKeys(): Promise<number>;
  hasLiveWatchForClass(classKey: ClassKey): Promise<boolean>;
}

/**
 * Create a bound repo object for use in the server layer.
 *
 * Usage in src/server/index.ts:
 *   import { getDb } from '../db/client';
 *   import { makeRepo } from '../db/repo-adapter';
 *   const app = createApp(makeRepo(getDb()));
 */
export function makeRepo(db: Db, options: CapacityAdmissionOptions = {}): BoundRepo {
  function shapeFreshness(rows: WatchFreshnessRecord[]): WatchFreshness[] {
    return rows.map((row) => ({
      classKey: row.classKey,
      source: 'public-class-page' as const,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      sourceStale: row.sourceStale,
      displayName: row.displayName,
      openSeats: row.openSeats,
      enrolled: row.enrolled,
      capacity: row.capacity,
      waitlisted: row.waitlisted,
      waitlistMax: row.waitlistMax,
      waitlistOpen: row.waitlistOpen,
    }));
  }

  async function freshness(subscriberId: string): Promise<WatchFreshness[]> {
    const rows = await listWatchFreshness(db, subscriberId);
    return shapeFreshness(rows);
  }

  return {
    async createSubscriber(email: string, classKeys: ClassKey[]) {
      const result = await createSubscriberWithWatches(db, email, classKeys, options);
      const watchFreshness = shapeFreshness(result.watchFreshness);
      return {
        id: result.subscriberId,
        watches: watchFreshness.map((entry) => entry.classKey),
        watchFreshness,
      };
    },

    async getSubscriberById(id: string) {
      const sub = await getSubscriberById(db, id);
      if (!sub) return null;
      const watchFreshness = await freshness(id);
      return {
        id: sub.id,
        email: sub.email,
        confirmed: sub.confirmedAt !== null,
        watches: watchFreshness.map((entry) => entry.classKey),
        watchFreshness,
      };
    },

    async addWatch(subscriberId: string, classKey: ClassKey) {
      const rows = await addWatchWithFreshness(db, subscriberId, classKey, options);
      const watchFreshness = shapeFreshness(rows);
      return { watches: watchFreshness.map((entry) => entry.classKey), watchFreshness };
    },

    async removeWatch(subscriberId: string, classKey: ClassKey) {
      await removeWatch(db, subscriberId, classKey);
    },

    async deleteSubscriber(id: string) {
      await deleteSubscriber(db, id);
    },

    async confirmSubscriber(id: string) {
      return confirmSubscriber(db, id, options);
    },

    async isSuppressed(email: string) {
      return isSuppressed(db, email);
    },

    async suppressEmail(email: string, reason: SuppressionReason) {
      await suppressEmail(db, email, reason);
    },

    async upsertPushSubscription(subscriberId: string, endpoint: string, keys: PushKeys) {
      await upsertPushSubscription(db, subscriberId, endpoint, keys);
    },

    async countPushSubscriptions(subscriberId: string) {
      return countPushSubscriptions(db, subscriberId);
    },

    async deletePushSubscriptionForSubscriber(subscriberId: string, endpoint: string) {
      return deletePushSubscriptionForSubscriber(db, subscriberId, endpoint);
    },

    async enqueueSubscriberMail(subscriberId: string, kind: SubscriberMailKind) {
      return enqueueSubscriberMail(db, subscriberId, kind);
    },

    async enqueueResendMailByEmail(email: string) {
      return enqueueResendMailByEmail(db, email);
    },

    async cancelClaimedMailJob(input: ClaimedMailCancellationInput) {
      return cancelClaimedMailJob(db, input);
    },

    async countDistinctLiveClassKeys() {
      return countDistinctLiveClassKeys(db);
    },

    async hasLiveWatchForClass(classKey: ClassKey) {
      return hasLiveWatchForClass(db, classKey);
    },
  };
}
