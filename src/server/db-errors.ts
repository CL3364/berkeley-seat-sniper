/**
 * Typed error narrowing for DB repo outcomes. The concrete error classes live in
 * `src/db` (DuplicateSubscriberError, DuplicateWatchError). This module provides
 * the narrowing helpers the route handlers use so the conflict → 409 and
 * not_found → 404 mapping stays in one place.
 */

import { DuplicateSubscriberError, DuplicateWatchError } from '../db';

/**
 * Returns true for any conflict-class error thrown by the db repo:
 *  - DuplicateSubscriberError — duplicate email on createSubscriberWithWatches → 409
 *  - DuplicateWatchError      — duplicate (subscriber_id, class_key) on addWatch → 409
 */
export function isConflictError(e: unknown): e is DuplicateSubscriberError | DuplicateWatchError {
  return e instanceof DuplicateSubscriberError || e instanceof DuplicateWatchError;
}

/**
 * Returns true for any not-found-class error thrown by the db repo. The repo's
 * current delete/remove operations are idempotent and do not throw, so this is
 * a forward-compatibility guard for if the db layer adds SubscriberNotFoundError
 * later. Maps to HTTP 404.
 */
export function isNotFoundError(e: unknown): boolean {
  // Name-based check because SubscriberNotFoundError is not yet exported from
  // src/db — update this to instanceof once the db barrel exports it.
  return e instanceof Error && e.constructor.name === 'SubscriberNotFoundError';
}
