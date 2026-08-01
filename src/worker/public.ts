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

export { inspectWorkerSourceDisabled, runPollCycle, startPoller } from './poller';
export type { Logger, PollCycleDeps, StartPollerOptions, WorkerHealthSnapshot } from './poller';

export type { CycleSummary, DurableWorkerRepo, RuntimeWorkerRepo, WorkerRepo } from './types';

export { createWorkerRepo } from './repo';

export {
  createFileSourceOriginControl,
  createMemorySourceOriginControl,
  defaultSourceOriginStateFile,
  sourceOriginFenceFile,
} from './source-origin-control';
export type {
  FileSourceOriginControlOptions,
  SourceOriginBlockClassification,
  SourceOriginControl,
  SourceOriginControlState,
  SourceOriginDeferResult,
  SourceOriginFence,
  SourceOriginFenceResult,
  SourceOriginPermitOptions,
  SourceOriginStartResult,
} from './source-origin-control';

export {
  SOURCE_SAFETY_STOP_RESET_CONFIRMATION,
  SourceSafetyStopResetDeferredError,
  createFileSourceSafetyStopStore,
  createMemorySourceSafetyStopStore,
  defaultSourceSafetyStopFile,
  resetSourceSafetyStop,
  sourceSafetyStopCliResetRejection,
} from './source-safety-stop';
export type {
  FileSourceSafetyStopStoreOptions,
  SourceSafetyStopCliResetRejection,
  SourceSafetyStopClassification,
  SourceSafetyStopEngageOptions,
  SourceSafetyStopReason,
  SourceSafetyStopState,
  SourceSafetyStopStore,
} from './source-safety-stop';

export {
  SourceScheduleState,
  abortableSleep,
  createMaintenanceState,
  drainMailOutboxOnce,
  readV04WorkerConfig,
  runOutboxDispatchCycle,
  runCacheAwarePollCycle,
  runSourcePollCycle,
} from './v04';
export type {
  CacheAwarePollCycleDeps,
  DrainMailOutboxOnceOptions,
  MaintenanceState,
  OutboxDrainSummary,
  OutboxDispatchCycleDeps,
  OutboxDispatchCycleSummary,
  SourceScheduleHealth,
  V04Logger,
  V04WorkerConfig,
} from './v04';
