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
import type { SeatStatus } from '../shared/seat-state';

// ---------------------------------------------------------------------------
// WorkerRepo
// ---------------------------------------------------------------------------

/**
 * The four db operations the poller needs, pre-bound to a specific db
 * connection. No `db` param — the binding is done at construction time in
 * `createWorkerRepo`. Tests inject a fake that satisfies this interface
 * without touching the real db.
 */
export interface WorkerRepo {
  /**
   * All distinct class keys currently watched by at least one subscriber.
   * The poller iterates this once per cycle to build the unique-class fetch
   * queue (FR-3: ONE fetch per unique class per interval).
   */
  getDistinctWatchedClassKeys(): Promise<ClassKey[]>;

  /**
   * All subscribers watching a given class. Used for fan-out after a
   * genuine opening is detected (FR-4). Returns only {id, email} — the
   * minimum PII surface needed by the notifier. Never log the emails (AC-8).
   */
  getSubscribersWatching(classKey: ClassKey): Promise<Array<{ id: string; email: string }>>;

  /**
   * Last-persisted state for a class. Returns `undefined` on first sighting
   * (the poller establishes a baseline without notifying on that first poll).
   */
  getClassState(classKey: ClassKey): Promise<
    | {
        classKey: ClassKey;
        lastStatus: SeatStatus;
        lastOpenSeats: number;
        lastWaitlistOpen: boolean;
        updatedAt: Date;
      }
    | undefined
  >;

  /**
   * Persist the new state for a class after a successful parse. MUST NOT be
   * called on a parser-broke result (FR-6 / AC-5).
   */
  upsertClassState(state: {
    classKey: ClassKey;
    lastStatus: SeatStatus;
    lastOpenSeats: number;
    lastWaitlistOpen: boolean;
  }): Promise<void>;
}

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
   * Total subscriber notifications dispatched this cycle (across all classes
   * and all subscribers). Counts only events where dispatch() returned
   * { sent: true }.
   */
  notified: number;

  /**
   * Notifications suppressed by the notifier's idempotency dedupe
   * (dispatched but already delivered). Under correct dedupe these should be
   * 0 in normal operation; a non-zero value indicates a bug in transition
   * detection or a replay.
   */
  suppressed: number;
}
