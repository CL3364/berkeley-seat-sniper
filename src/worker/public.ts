/**
 * src/worker/public.ts
 *
 * Public surface of the worker lane. Import from this file (or from the
 * individual modules below) — never reach into poller.ts internals directly.
 *
 * Exported for test-engineer consumption:
 *   - runPollCycle + PollCycleDeps + Logger — drive the cycle deterministically
 *   - WorkerRepo + CycleSummary types — build fakes and assert on outcomes
 *   - createWorkerRepo — wire a real WorkerRepo from makeTestDb()
 */

export { runPollCycle, startPoller } from './poller';
export type { PollCycleDeps, Logger } from './poller';

export type { WorkerRepo, CycleSummary } from './types';

export { createWorkerRepo } from './repo';
