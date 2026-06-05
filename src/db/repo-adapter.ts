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

import type { ClassKey } from '../shared/class-key';
import type { Db } from './client';
import {
  addWatch,
  createSubscriberWithWatches,
  deleteSubscriber,
  getSubscriberById,
  listWatches,
  removeWatch,
} from './repo';

/** Minimal subscriber record shape expected by the server route handlers. */
export interface SubscriberRecord {
  id: string;
  email: string;
  watches: ClassKey[];
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
  ): Promise<{ id: string; watches: ClassKey[] }>;
  getSubscriberById(id: string): Promise<SubscriberRecord | null>;
  addWatch(subscriberId: string, classKey: ClassKey): Promise<{ watches: ClassKey[] }>;
  removeWatch(subscriberId: string, classKey: ClassKey): Promise<void>;
  deleteSubscriber(id: string): Promise<void>;
}

/**
 * Create a bound repo object for use in the server layer.
 *
 * Usage in src/server/index.ts:
 *   import { getDb } from '../db/client';
 *   import { makeRepo } from '../db/repo-adapter';
 *   const app = createApp(makeRepo(getDb()));
 */
export function makeRepo(db: Db): BoundRepo {
  return {
    async createSubscriber(email: string, classKeys: ClassKey[]) {
      const result = await createSubscriberWithWatches(db, email, classKeys);
      return { id: result.subscriberId, watches: result.watches };
    },

    async getSubscriberById(id: string) {
      const sub = await getSubscriberById(db, id);
      if (!sub) return null;
      const watches = await listWatches(db, id);
      return { id: sub.id, email: sub.email, watches };
    },

    async addWatch(subscriberId: string, classKey: ClassKey) {
      const watches = await addWatch(db, subscriberId, classKey);
      return { watches };
    },

    async removeWatch(subscriberId: string, classKey: ClassKey) {
      await removeWatch(db, subscriberId, classKey);
    },

    async deleteSubscriber(id: string) {
      await deleteSubscriber(db, id);
    },
  };
}
