/**
 * Typed error narrowing for DB repo outcomes. The concrete error classes live in
 * `src/db` (DuplicateSubscriberError, DuplicateWatchError). This module provides
 * the narrowing helpers the route handlers use so the conflict → 409 and
 * not_found → 404 mapping stays in one place.
 */

import {
  DuplicateSubscriberError,
  DuplicateWatchError,
  PushSubscriptionLimitError,
  SubscriberCapacityError,
  SubscriberNotFoundError,
  UniqueSectionCapacityError,
  WatchLimitError,
} from '../db';

/**
 * Returns true for any conflict-class error thrown by the db repo:
 *  - DuplicateSubscriberError — duplicate email on createSubscriberWithWatches → 409
 *  - DuplicateWatchError      — duplicate (subscriber_id, class_key) on addWatch → 409
 *  - PushSubscriptionLimitError — sixth browser registration → 409
 */
export function isConflictError(
  e: unknown,
): e is DuplicateSubscriberError | DuplicateWatchError | PushSubscriptionLimitError {
  return (
    e instanceof DuplicateSubscriberError ||
    e instanceof DuplicateWatchError ||
    e instanceof PushSubscriptionLimitError
  );
}

/** A Subscriber already holds the contract maximum of LIVE Watches. */
export function isWatchLimitError(e: unknown): e is WatchLimitError {
  return e instanceof WatchLimitError;
}

/**
 * Returns true for any not-found-class error thrown by the db repo. The repo's
 * current delete/remove operations are idempotent and do not throw, so this is
 * a forward-compatibility guard for if the db layer adds SubscriberNotFoundError
 * later. Maps to HTTP 404.
 */
export function isNotFoundError(e: unknown): e is SubscriberNotFoundError {
  return e instanceof SubscriberNotFoundError;
}

/** A new unique Section would exceed the configured polite source budget. */
export function isCapacityError(e: unknown): e is UniqueSectionCapacityError {
  return e instanceof UniqueSectionCapacityError;
}

/** The pilot's atomic Pending + Confirmed Subscriber cap was reached. */
export function isSubscriberCapacityError(e: unknown): e is SubscriberCapacityError {
  return e instanceof SubscriberCapacityError;
}
