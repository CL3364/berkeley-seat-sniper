/**
 * src/worker/repo.ts
 *
 * Binds the raw db fan-out functions (each of which takes a `db` argument
 * first) into a `WorkerRepo`-shaped object with a fixed db connection. The
 * test-engineer can build a fake `WorkerRepo` directly; this adapter is what
 * `startPoller` wires for production.
 *
 * Lane: src/worker/** — owned by worker-engineer.
 * Imports from ../db (read-only; db lane owns the implementation).
 */

import type { Db } from '../db';
import {
  getClassState,
  getDistinctWatchedClassKeys,
  getSubscribersWatching,
  upsertClassState,
} from '../db';
import type { SeatStatus } from '../shared/seat-state';
import type { WorkerRepo } from './types';
import type { ClassKey } from '../shared/class-key';

/**
 * Create a `WorkerRepo` bound to the given db connection. Call once at
 * startup with `getDb()` (production) or `makeTestDb()` (integration tests).
 *
 * PII note: this file never logs anything — callers own log discipline.
 */
export function createWorkerRepo(db: Db): WorkerRepo {
  return {
    getDistinctWatchedClassKeys(): Promise<ClassKey[]> {
      return getDistinctWatchedClassKeys(db);
    },

    getSubscribersWatching(classKey: ClassKey): Promise<Array<{ id: string; email: string }>> {
      return getSubscribersWatching(db, classKey);
    },

    getClassState(classKey: ClassKey) {
      return getClassState(db, classKey);
    },

    upsertClassState(state: {
      classKey: ClassKey;
      lastStatus: SeatStatus;
      lastOpenSeats: number;
      lastWaitlistOpen: boolean;
    }): Promise<void> {
      return upsertClassState(db, state);
    },
  };
}
