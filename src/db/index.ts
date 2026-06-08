/**
 * Public barrel for the db lane. Consumers import from '../db' (or '../../db').
 * Re-exports the schema types, client helpers, and all repo functions.
 */

// Schema table references (for advanced queries in tests)
export { classState, subscribers, watches } from './schema';
export type {
  ClassStateRow,
  NewClassStateRow,
  NewSubscriber,
  NewWatch,
  Subscriber,
  Watch,
} from './schema';

// DB client and test helpers
export { getDb, makeTestDb, runMigrations } from './client';
export type { Db } from './client';

// Typed error sentinels
export { DuplicateSubscriberError, DuplicateWatchError } from './repo';

// Subscription / watch repo functions
export {
  addWatch,
  createSubscriberWithWatches,
  deleteSubscriber,
  getSubscriberByEmail,
  getSubscriberById,
  listWatches,
  removeWatch,
} from './repo';

// Worker fan-out repo functions
export {
  getClassState,
  getDistinctWatchedClassKeys,
  getSubscribersWatching,
  upsertClassState,
} from './repo';

// Binding adapter for the server layer — wraps repo fns into a SubscriptionRepo-shaped object
export { makeRepo } from './repo-adapter';
export type { BoundRepo, SubscriberRecord as DbSubscriberRecord } from './repo-adapter';
