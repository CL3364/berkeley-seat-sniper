/**
 * v0.4 production worker core.
 *
 * This module deliberately sits beside the legacy deterministic poll-cycle
 * harness. Production uses the cache-aware source and durable mail queue here;
 * older tests can keep driving `runPollCycle` until their fixtures migrate.
 */

import type {
  MailDispatchJob,
  MailDispatchResult,
  MailDispatcher,
  ProviderOutcome,
} from '../notify';
import {
  FetchError,
  isSourceFetchingEnabled,
  type AvailabilitySource,
  type RunWithOriginPermit,
  type SourceCacheMetadata,
  type SourceValidators,
} from '../scraper';
import type { ClassKey } from '../shared/class-key';
import { isClassGone, isParserBroke } from '../shared/seat-state';
import {
  ROBOTS_EPISODE_KEY,
  createOperatorAlertDebouncer,
  type OperatorAlertDebouncer,
} from './operator-debounce';
import {
  createMemorySourceOriginControl,
  type SourceOriginBlockClassification,
  type SourceOriginControl,
} from './source-origin-control';
import {
  createMemorySourceSafetyStopStore,
  type SourceSafetyStopReason,
  type SourceSafetyStopState,
  type SourceSafetyStopStore,
} from './source-safety-stop';
import type { CycleSummary, RetentionSweepResult, RuntimeWorkerRepo } from './types';
import { dashboardObservationsForPersistence } from './dashboard-observations';

const ROBOTS_DETAIL_PREFIX = 'robots.txt:';
const MAX_OUTBOX_BATCHES_PER_DRAIN = 4;
const OUTBOX_STATE_WRITE_CONCURRENCY = 10;
const INCIDENT_PUBLISH_CONCURRENCY = 5;
const DEFAULT_MAIL_RETRY_BASE_MS = 30_000;
const MAX_SOURCE_SAFETY_RESUME_DELAY_MS = 86_400_000;

export interface V04WorkerConfig {
  pollHeartbeatMs: number;
  pollJitterMs: number;
  maxBackoffMs: number;
  sourceVisibleTargetMs: number;
  sourceRequestsPerSecond: number;
  outboxBatchSize: number;
  outboxClaimLeaseSeconds: number;
  retentionSweepIntervalMs: number;
  healthSourceMaxStaleMs: number;
  healthOutboxMaxAgeMs: number;
}

export interface V04Logger {
  info(obj: Record<string, unknown>): void;
  warn(obj: Record<string, unknown>): void;
  error(obj: Record<string, unknown>): void;
}

export interface MaintenanceState {
  lastRetentionSweepAtMs: number | null;
}

export function createMaintenanceState(): MaintenanceState {
  return { lastRetentionSweepAtMs: null };
}

export function readV04WorkerConfig(env: NodeJS.ProcessEnv = process.env): V04WorkerConfig {
  const pollHeartbeatSeconds = positiveIntegerEnv(env, 'POLL_INTERVAL_SECONDS', 30);
  const pollJitterSeconds = nonnegativeIntegerEnv(env, 'POLL_JITTER_SECONDS', 10);
  if (pollJitterSeconds > pollHeartbeatSeconds) {
    throw new Error('POLL_JITTER_SECONDS must not exceed POLL_INTERVAL_SECONDS');
  }
  const sourceRequestsPerSecond = positiveNumberEnv(env, 'SOURCE_REQUESTS_PER_SECOND', 1);
  if (sourceRequestsPerSecond > 1) {
    throw new Error('SOURCE_REQUESTS_PER_SECOND must be at most 1');
  }

  return {
    pollHeartbeatMs: pollHeartbeatSeconds * 1_000,
    pollJitterMs: pollJitterSeconds * 1_000,
    maxBackoffMs: positiveIntegerEnv(env, 'MAX_BACKOFF_SECONDS', 600) * 1_000,
    sourceVisibleTargetMs: positiveIntegerEnv(env, 'SOURCE_VISIBLE_TARGET_SECONDS', 120) * 1_000,
    sourceRequestsPerSecond,
    outboxBatchSize: boundedIntegerEnv(env, 'OUTBOX_BATCH_SIZE', 100, 1, 1_000),
    outboxClaimLeaseSeconds: boundedIntegerEnv(env, 'OUTBOX_CLAIM_LEASE_SECONDS', 60, 1, 3_600),
    retentionSweepIntervalMs:
      positiveIntegerEnv(env, 'RETENTION_SWEEP_INTERVAL_SECONDS', 3_600) * 1_000,
    healthSourceMaxStaleMs: positiveIntegerEnv(env, 'HEALTH_SOURCE_MAX_STALE_SECONDS', 240) * 1_000,
    healthOutboxMaxAgeMs: positiveIntegerEnv(env, 'HEALTH_OUTBOX_MAX_AGE_SECONDS', 120) * 1_000,
  };
}

interface SourceScheduleEntry {
  validators?: SourceValidators;
  previousCache?: SourceCacheMetadata;
  nextEligibleAtMs: number;
  consecutiveFailures: number;
  lastSuccessfulObservationAtMs?: number;
  baselineFreshUntilMs?: number;
}

export interface SourceScheduleHealth {
  staleCount: number;
  oldestSuccessfulObservationAgeMs: number | null;
}

/**
 * Process-local conditional-request and deadline state.
 *
 * Validators intentionally remain in memory: after a restart the worker makes
 * an unconditional request, which is safer than sending a validator without
 * the exact representation metadata needed to interpret a 304.
 */
export class SourceScheduleState {
  private readonly entries = new Map<ClassKey, SourceScheduleEntry>();
  private nextOriginRequestAtMs = 0;
  private globalBlockedUntilMs = 0;

  prune(activeClassKeys: readonly ClassKey[]): void {
    const active = new Set(activeClassKeys);
    for (const classKey of this.entries.keys()) {
      if (!active.has(classKey)) this.entries.delete(classKey);
    }
  }

  dueClassKeys(activeClassKeys: readonly ClassKey[], nowMs: number): ClassKey[] {
    return activeClassKeys
      .filter((classKey) => {
        const entry = this.entries.get(classKey);
        return entry === undefined || entry.nextEligibleAtMs <= nowMs;
      })
      .sort((left, right) => {
        const leftDue = this.entries.get(left)?.nextEligibleAtMs ?? 0;
        const rightDue = this.entries.get(right)?.nextEligibleAtMs ?? 0;
        return leftDue - rightDue || left.localeCompare(right);
      });
  }

  requestFor(
    classKey: ClassKey,
    hasPersistedState: boolean,
  ): {
    validators?: SourceValidators;
    previousCache?: SourceCacheMetadata;
  } {
    const entry = this.entries.get(classKey);
    if (!entry || !hasPersistedState || !entry.previousCache || !entry.validators) {
      return {};
    }
    return {
      validators: { ...entry.validators },
      previousCache: entry.previousCache,
    };
  }

  canAcceptNotModified(classKey: ClassKey, hasPersistedState: boolean): boolean {
    const entry = this.entries.get(classKey);
    return Boolean(
      hasPersistedState &&
      entry?.previousCache &&
      entry.validators &&
      (entry.validators.etag || entry.validators.lastModified),
    );
  }

  async waitForOriginPermit(
    config: V04WorkerConfig,
    nowMs: () => number,
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const current = nowMs();
    const eligibleAt = Math.max(this.nextOriginRequestAtMs, this.globalBlockedUntilMs);
    if (eligibleAt > current) {
      await sleep(eligibleAt - current, signal);
    }
    if (signal?.aborted) return false;

    const startedAt = nowMs();
    const spacingMs = Math.ceil(1_000 / config.sourceRequestsPerSecond);
    this.nextOriginRequestAtMs = Math.max(this.nextOriginRequestAtMs, startedAt) + spacingMs;
    return true;
  }

  recordSuccessfulObservation(
    classKey: ClassKey,
    cache: SourceCacheMetadata,
    config: V04WorkerConfig,
    random: () => number,
  ): void {
    const timing = sourceTiming(cache, config, random);
    const validators = validatorsFromCache(cache);
    this.entries.set(classKey, {
      ...(validators ? { validators } : {}),
      previousCache: cache,
      nextEligibleAtMs: timing.nextEligibleAtMs,
      consecutiveFailures: 0,
      lastSuccessfulObservationAtMs: timing.checkedAtMs,
      baselineFreshUntilMs: timing.baselineFreshUntilMs,
    });
  }

  recordUnparseableResponse(
    classKey: ClassKey,
    cache: SourceCacheMetadata | null,
    config: V04WorkerConfig,
    nowMs: number,
    random: () => number,
  ): void {
    const previous = this.entries.get(classKey);
    const timing = cache
      ? sourceTiming(cache, config, random)
      : {
          nextEligibleAtMs: nowMs + config.sourceVisibleTargetMs,
          baselineFreshUntilMs: previous?.baselineFreshUntilMs,
        };
    this.entries.set(classKey, {
      nextEligibleAtMs: timing.nextEligibleAtMs,
      consecutiveFailures: 0,
      ...(previous?.lastSuccessfulObservationAtMs !== undefined
        ? { lastSuccessfulObservationAtMs: previous.lastSuccessfulObservationAtMs }
        : {}),
      ...(previous?.baselineFreshUntilMs !== undefined
        ? { baselineFreshUntilMs: previous.baselineFreshUntilMs }
        : {}),
    });
  }

  recordFailure(
    classKey: ClassKey,
    retryAfterMs: number | null,
    config: V04WorkerConfig,
    nowMs: number,
    random: () => number,
  ): number {
    const previous = this.entries.get(classKey);
    const failures = (previous?.consecutiveFailures ?? 0) + 1;
    const exponentialMs = Math.min(
      config.pollHeartbeatMs * Math.pow(2, Math.min(failures - 1, 20)),
      config.maxBackoffMs,
    );
    const requestedDelayMs =
      retryAfterMs === null || !Number.isFinite(retryAfterMs) ? 0 : Math.max(0, retryAfterMs);
    const delayMs =
      Math.max(exponentialMs, requestedDelayMs) + boundedJitter(config.pollJitterMs, random);
    this.entries.set(classKey, {
      ...(previous?.validators ? { validators: previous.validators } : {}),
      ...(previous?.previousCache ? { previousCache: previous.previousCache } : {}),
      nextEligibleAtMs: nowMs + delayMs,
      consecutiveFailures: failures,
      ...(previous?.lastSuccessfulObservationAtMs !== undefined
        ? { lastSuccessfulObservationAtMs: previous.lastSuccessfulObservationAtMs }
        : {}),
      ...(previous?.baselineFreshUntilMs !== undefined
        ? { baselineFreshUntilMs: previous.baselineFreshUntilMs }
        : {}),
    });
    return nowMs + delayMs;
  }

  blockOrigin(untilMs: number): void {
    if (Number.isFinite(untilMs)) {
      this.globalBlockedUntilMs = Math.max(this.globalBlockedUntilMs, untilMs);
    }
  }

  deferThrough(classKeys: readonly ClassKey[], untilMs: number): void {
    for (const classKey of classKeys) {
      const previous = this.entries.get(classKey);
      this.entries.set(classKey, {
        ...(previous?.validators ? { validators: previous.validators } : {}),
        ...(previous?.previousCache ? { previousCache: previous.previousCache } : {}),
        nextEligibleAtMs: Math.max(previous?.nextEligibleAtMs ?? 0, untilMs),
        consecutiveFailures: previous?.consecutiveFailures ?? 0,
        ...(previous?.lastSuccessfulObservationAtMs !== undefined
          ? { lastSuccessfulObservationAtMs: previous.lastSuccessfulObservationAtMs }
          : {}),
        ...(previous?.baselineFreshUntilMs !== undefined
          ? { baselineFreshUntilMs: previous.baselineFreshUntilMs }
          : {}),
      });
    }
  }

  forget(classKey: ClassKey): void {
    this.entries.delete(classKey);
  }

  baselineFreshUntil(classKey: ClassKey): number | undefined {
    return this.entries.get(classKey)?.baselineFreshUntilMs;
  }

  nextWakeAt(activeClassKeys: readonly ClassKey[], nowMs: number): number | null {
    if (activeClassKeys.length === 0) return null;
    let next = Number.POSITIVE_INFINITY;
    for (const classKey of activeClassKeys) {
      const eligibleAt = this.entries.get(classKey)?.nextEligibleAtMs ?? nowMs;
      next = Math.min(next, Math.max(eligibleAt, this.globalBlockedUntilMs));
    }
    return Number.isFinite(next) ? next : nowMs;
  }

  health(
    activeClassKeys: readonly ClassKey[],
    nowMs: number,
    maxStaleMs: number,
  ): SourceScheduleHealth {
    let staleCount = 0;
    let oldestSuccessfulObservationAgeMs: number | null = null;
    for (const classKey of activeClassKeys) {
      const entry = this.entries.get(classKey);
      const lastSuccess = entry?.lastSuccessfulObservationAtMs;
      if (lastSuccess !== undefined) {
        const ageMs = Math.max(0, nowMs - lastSuccess);
        oldestSuccessfulObservationAgeMs = Math.max(oldestSuccessfulObservationAgeMs ?? 0, ageMs);
      }
      const healthyThrough = Math.max(
        entry?.baselineFreshUntilMs ?? 0,
        lastSuccess === undefined ? 0 : lastSuccess + maxStaleMs,
      );
      if (healthyThrough < nowMs) staleCount += 1;
    }
    return { staleCount, oldestSuccessfulObservationAgeMs };
  }
}

export interface OutboxDrainSummary {
  claimed: number;
  sent: number;
  suppressed: number;
  deferred: number;
  cancelledExpired: number;
  deadLettered: number;
  claimFenceLost: number;
}

export interface DrainMailOutboxOnceOptions {
  repo: RuntimeWorkerRepo;
  dispatcher: MailDispatcher;
  batchSize?: number;
  claimLeaseSeconds?: number;
  maxBackoffMs?: number;
  logger?: V04Logger;
  nowMs?: () => number;
  signal?: AbortSignal;
}

/**
 * Narrow same-process seam for E2E/dev harnesses using PGlite. It drains
 * already-enqueued work only; it starts no scheduler, signal handlers, source
 * requests, or background process.
 */
export async function drainMailOutboxOnce(
  options: DrainMailOutboxOnceOptions,
): Promise<OutboxDrainSummary> {
  const defaults = readV04WorkerConfig();
  return drainMailOutbox({
    repo: options.repo,
    dispatcher: options.dispatcher,
    config: {
      ...defaults,
      ...(options.batchSize === undefined ? {} : { outboxBatchSize: options.batchSize }),
      ...(options.claimLeaseSeconds === undefined
        ? {}
        : { outboxClaimLeaseSeconds: options.claimLeaseSeconds }),
      ...(options.maxBackoffMs === undefined ? {} : { maxBackoffMs: options.maxBackoffMs }),
    },
    logger: options.logger ?? defaultLogger(),
    nowMs: options.nowMs ?? Date.now,
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress: () => undefined,
  });
}

export interface CacheAwarePollCycleDeps {
  repo: RuntimeWorkerRepo;
  source: AvailabilitySource;
  mailDispatcher: MailDispatcher;
  schedule?: SourceScheduleState;
  maintenance?: MaintenanceState;
  config?: V04WorkerConfig;
  debouncer?: OperatorAlertDebouncer;
  logger?: V04Logger;
  nowMs?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onProgress?(): void;
  /**
   * Durable in production, injectable for tests. A one-shot harness defaults
   * to a call-scoped memory store so unrelated test runs never share /tmp.
   */
  sourceSafetyStop?: SourceSafetyStopStore;
  /**
   * Cross-process source single-flight and durable physical-request spacing.
   * Production injects a file-backed control; one-shot harnesses stay local.
   */
  sourceOriginControl?: SourceOriginControl;
  /**
   * Production source-loop mode. When true this function performs no outbox,
   * provider, expiration, or retention work; the independent dispatcher loop
   * owns those operations.
   */
  sourceOnly?: boolean;
}

/** Production source path: it never awaits outbox or provider work. */
export async function runSourcePollCycle(
  deps: Omit<CacheAwarePollCycleDeps, 'sourceOnly'>,
): Promise<CycleSummary> {
  return runCacheAwarePollCycle({ ...deps, sourceOnly: true });
}

export interface OutboxDispatchCycleDeps {
  repo: RuntimeWorkerRepo;
  mailDispatcher: MailDispatcher;
  maintenance?: MaintenanceState;
  config?: V04WorkerConfig;
  logger?: V04Logger;
  nowMs?: () => number;
  signal?: AbortSignal;
  onProgress?(): void;
}

export interface OutboxDispatchCycleSummary extends OutboxDrainSummary {
  expired: number;
  incidentsClaimed: number;
  incidentsPublished: number;
  incidentPublishDeferred: number;
  incidentSurfaceFenceLost: number;
  retentionPurged: number;
  outboxQueued: number;
  outboxProcessing: number;
  outboxDeadLetter: number;
  outboxOldestQueuedAgeMs: number | null;
  healthy: boolean;
}

/**
 * One bounded iteration of the independent dispatcher/maintenance loop.
 * Claims finish before provider I/O in the DB lane; this function is never
 * awaited by the production source scheduler.
 */
export async function runOutboxDispatchCycle(
  deps: OutboxDispatchCycleDeps,
): Promise<OutboxDispatchCycleSummary> {
  const config = deps.config ?? readV04WorkerConfig();
  const maintenance = deps.maintenance ?? createMaintenanceState();
  const log = deps.logger ?? defaultLogger();
  const nowMs = deps.nowMs ?? Date.now;
  const onProgress = deps.onProgress ?? (() => undefined);

  const expired = await deps.repo.expireMailOutboxAlerts();
  onProgress();
  if (expired > 0) {
    log.info({ event: 'outbox_alerts_expired', count: expired });
  }

  const drain = await drainMailOutbox({
    repo: deps.repo,
    dispatcher: deps.mailDispatcher,
    config,
    logger: log,
    nowMs,
    ...(deps.signal ? { signal: deps.signal } : {}),
    onProgress,
  });

  const incidents = await deps.repo.claimDeadLetterIncidentsForSurface({
    limit: config.outboxBatchSize,
  });
  onProgress();
  const incidentSummary = {
    published: 0,
    deferred: 0,
    fenceLost: 0,
  };
  await mapWithConcurrency(incidents, INCIDENT_PUBLISH_CONCURRENCY, async (incident) => {
    if (deps.signal?.aborted) {
      incidentSummary.deferred += 1;
      return;
    }
    const publish = deps.mailDispatcher.publishDeadLetterIncident;
    if (!publish) {
      incidentSummary.deferred += 1;
      log.error({
        event: 'dead_letter_incident_publish_unavailable',
        incidentId: incident.id,
        classification: 'incident_publisher_unavailable',
      });
      return;
    }

    let outcome: ProviderOutcome;
    try {
      outcome = await publish(incident);
    } catch {
      incidentSummary.deferred += 1;
      log.error({
        event: 'dead_letter_incident_publish_failed',
        incidentId: incident.id,
        classification: 'incident_publisher_failed',
      });
      return;
    }
    onProgress();
    if (outcome.status !== 'success') {
      incidentSummary.deferred += 1;
      log.warn({
        event: 'dead_letter_incident_publish_deferred',
        incidentId: incident.id,
        classification: incidentOutcomeClassification(outcome.status),
      });
      return;
    }

    const marked = await deps.repo.markDeadLetterIncidentSurfaced({
      id: incident.id,
      surfacedAt: outcome.acceptedAt,
    });
    onProgress();
    if (marked) {
      incidentSummary.published += 1;
      log.info({
        event: 'dead_letter_incident_surfaced',
        incidentId: incident.id,
      });
    } else {
      incidentSummary.fenceLost += 1;
      log.warn({
        event: 'dead_letter_incident_surface_fence_lost',
        incidentId: incident.id,
      });
    }
  });

  let retentionPurged = 0;
  const currentMs = nowMs();
  if (
    maintenance.lastRetentionSweepAtMs === null ||
    currentMs - maintenance.lastRetentionSweepAtMs >= config.retentionSweepIntervalMs
  ) {
    const swept = await deps.repo.sweepRetention(new Date(currentMs));
    maintenance.lastRetentionSweepAtMs = currentMs;
    retentionPurged = retentionCount(swept);
    onProgress();
    log.info({
      event: 'retention_sweep_complete',
      pendingSubscribers: swept.pendingSubscribers,
      terminalMailJobs: swept.terminalMailJobs,
      legacyAlertDeliveries: swept.legacyAlertDeliveries,
      retiredWatches: swept.retiredWatches,
      orphanedClassStates: swept.orphanedClassStates,
      expiredMailJobs: swept.expiredMailJobs,
    });
  }

  const outbox = await deps.repo.getMailOutboxHealth();
  onProgress();
  const oldestQueuedAgeMs = outbox.oldestQueuedAt
    ? Math.max(0, nowMs() - outbox.oldestQueuedAt.getTime())
    : null;
  const healthy =
    outbox.deadLetter === 0 &&
    (oldestQueuedAgeMs === null || oldestQueuedAgeMs <= config.healthOutboxMaxAgeMs);

  return {
    ...drain,
    expired,
    incidentsClaimed: incidents.length,
    incidentsPublished: incidentSummary.published,
    incidentPublishDeferred: incidentSummary.deferred,
    incidentSurfaceFenceLost: incidentSummary.fenceLost,
    retentionPurged,
    outboxQueued: outbox.queued,
    outboxProcessing: outbox.processing,
    outboxDeadLetter: outbox.deadLetter,
    outboxOldestQueuedAgeMs: oldestQueuedAgeMs,
    healthy,
  };
}

/**
 * Combined one-shot harness retained for integration/E2E use. Production calls
 * {@link runSourcePollCycle} and {@link runOutboxDispatchCycle} from independent
 * loops so provider latency is absent from the source critical path.
 */
export async function runCacheAwarePollCycle(deps: CacheAwarePollCycleDeps): Promise<CycleSummary> {
  const config = deps.config ?? readV04WorkerConfig();
  const schedule = deps.schedule ?? new SourceScheduleState();
  const maintenance = deps.maintenance ?? createMaintenanceState();
  const debouncer = deps.debouncer ?? createOperatorAlertDebouncer();
  const log = deps.logger ?? defaultLogger();
  const nowMs = deps.nowMs ?? Date.now;
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? abortableSleep;
  const onProgress = deps.onProgress ?? (() => undefined);
  const signal = deps.signal;
  const sourceOnly = deps.sourceOnly === true;
  const sourceSafetyStop = deps.sourceSafetyStop ?? createMemorySourceSafetyStopStore();
  const sourceOriginControl = deps.sourceOriginControl ?? createMemorySourceOriginControl();

  const activeClassKeys = await deps.repo.getDistinctWatchedClassKeys();
  onProgress();
  schedule.prune(activeClassKeys);

  const counters = {
    fetched: 0,
    sourceRequests: 0,
    sourceNotModified: 0,
    sourceFailures: 0,
    sourceDeferred: 0,
    parserBroke: [] as ClassKey[],
    classGone: [] as ClassKey[],
    operatorAlerted: [] as string[],
    robotsSkipped: 0,
    enqueued: 0,
  };

  let retentionPurged = 0;
  let expiredAtStart = 0;
  let firstDrain = emptyDrainSummary();
  if (!sourceOnly) {
    expiredAtStart = await deps.repo.expireMailOutboxAlerts();
    onProgress();
    if (expiredAtStart > 0) {
      log.info({ event: 'outbox_alerts_expired', count: expiredAtStart });
    }

    firstDrain = await drainMailOutbox({
      repo: deps.repo,
      dispatcher: deps.mailDispatcher,
      config,
      logger: log,
      nowMs,
      signal,
      onProgress,
    });
  }

  const currentMs = nowMs();
  if (
    !sourceOnly &&
    (maintenance.lastRetentionSweepAtMs === null ||
      currentMs - maintenance.lastRetentionSweepAtMs >= config.retentionSweepIntervalMs)
  ) {
    const swept = await deps.repo.sweepRetention(new Date(currentMs));
    maintenance.lastRetentionSweepAtMs = currentMs;
    retentionPurged = retentionCount(swept);
    onProgress();
    log.info({
      event: 'retention_sweep_complete',
      pendingSubscribers: swept.pendingSubscribers,
      terminalMailJobs: swept.terminalMailJobs,
      legacyAlertDeliveries: swept.legacyAlertDeliveries,
      retiredWatches: swept.retiredWatches,
      orphanedClassStates: swept.orphanedClassStates,
      expiredMailJobs: swept.expiredMailJobs,
    });
  }

  const killSwitch = !isSourceFetchingEnabled();
  let safetyStopState = await inspectSourceSafetyStop(sourceSafetyStop);
  let sourceDisabled = killSwitch || safetyStopState.stopped;
  if (killSwitch) {
    counters.sourceDeferred = activeClassKeys.length;
    log.info({
      event: 'source_cycle_skipped',
      reason: 'kill-switch',
      classCount: activeClassKeys.length,
    });
  } else if (safetyStopState.stopped) {
    counters.sourceDeferred = activeClassKeys.length;
    log.warn({
      event: 'source_cycle_skipped',
      classification: safetyStopState.classification,
    });
  } else if (!signal?.aborted) {
    const due = schedule.dueClassKeys(activeClassKeys, nowMs());
    counters.sourceDeferred = activeClassKeys.length - due.length;
    if (due.length > 0) {
      const cycleCutoff = await deps.repo.getPollCycleCutoff();
      onProgress();
      deps.source.beginCycle();
      try {
        for (let index = 0; index < due.length; index += 1) {
          if (signal?.aborted) {
            counters.sourceDeferred += due.length - index;
            break;
          }
          const classKey = due[index]!;
          const originFenceResult = await sourceOriginControl.acquireFence().catch(
            (): {
              acquired: false;
              classification: SourceOriginBlockClassification;
            } => ({
              acquired: false,
              classification: 'origin_fence_unavailable',
            }),
          );
          if (!originFenceResult.acquired) {
            sourceDisabled = true;
            counters.sourceDeferred += due.length - index;
            onProgress();
            log.warn({
              event: 'source_cycle_interrupted',
              classification: originFenceResult.classification,
            });
            break;
          }
          const originFence = originFenceResult.fence;
          try {
            const previous = await deps.repo.getClassState(classKey);
            onProgress();
            const permitInterlock: {
              safetyStop: Extract<SourceSafetyStopState, { stopped: true }> | null;
              killSwitch: boolean;
              originBlock: SourceOriginBlockClassification | null;
            } = {
              safetyStop: null,
              killSwitch: false,
              originBlock: null,
            };
            const runWithOriginPermit: RunWithOriginPermit = async (context, start) => {
              const combined = combineAbortSignals(signal, context.signal);
              try {
                const durableStart = await originFence.runWithPermit(
                  {
                    requestsPerSecond: config.sourceRequestsPerSecond,
                    nowMs,
                    sleep,
                    signal: combined.signal,
                    beforeStart: async () => {
                      // This is the final worker-owned interlock before every
                      // physical robots/class/redirect request. Another owner
                      // may have latched the shared marker while this request
                      // waited for the durable origin budget.
                      const liveSafetyStop = await inspectSourceSafetyStop(sourceSafetyStop);
                      const liveKillSwitch = !isSourceFetchingEnabled();
                      if (liveSafetyStop.stopped || liveKillSwitch) {
                        permitInterlock.safetyStop = liveSafetyStop.stopped ? liveSafetyStop : null;
                        permitInterlock.killSwitch = liveKillSwitch;
                        return false;
                      }
                      return true;
                    },
                  },
                  () => {
                    counters.sourceRequests += 1;
                    return start();
                  },
                );
                if (durableStart.status === 'blocked') {
                  permitInterlock.originBlock = durableStart.classification;
                  originFence.retain();
                  throw createAbortError();
                }
                if (durableStart.status === 'aborted' || durableStart.status === 'interrupted') {
                  throw createAbortError();
                }

                return durableStart.value;
              } finally {
                combined.dispose();
              }
            };
            const request = {
              ...schedule.requestFor(classKey, previous !== undefined),
              runWithOriginPermit,
            };
            let observation: Awaited<ReturnType<AvailabilitySource['fetch']>>;
            try {
              observation = await deps.source.fetch(classKey, request);
              counters.fetched += 1;
              onProgress();
            } catch (error) {
              if (
                permitInterlock.originBlock !== null ||
                permitInterlock.safetyStop !== null ||
                permitInterlock.killSwitch
              ) {
                sourceDisabled = true;
                if (permitInterlock.originBlock !== null) {
                  originFence.retain();
                }
                if (permitInterlock.safetyStop !== null) {
                  safetyStopState = permitInterlock.safetyStop;
                }
                onProgress();
                // The current Section did not complete, and no later Section
                // may start. Do not turn this intentional interlock into a
                // transient source failure.
                counters.sourceDeferred += due.length - index;
                log.warn({
                  event: 'source_cycle_interrupted',
                  classification:
                    permitInterlock.originBlock ??
                    (permitInterlock.killSwitch
                      ? 'kill_switch_active'
                      : (permitInterlock.safetyStop?.classification ?? 'marker_unreadable')),
                });
                break;
              }

              counters.sourceFailures += 1;
              const fetchError =
                error instanceof FetchError
                  ? error
                  : new FetchError(0, 'unexpected source failure');
              const failedAt = nowMs();
              const eligibleAt = schedule.recordFailure(
                classKey,
                fetchError.retryAfterMs,
                config,
                failedAt,
                random,
              );
              const safetyReason = safetyStopReason(fetchError);
              if (safetyReason !== null) {
                const resumeDelayMs = Math.min(
                  MAX_SOURCE_SAFETY_RESUME_DELAY_MS,
                  Math.max(0, eligibleAt - failedAt),
                );
                const originCooldown = await originFence.deferUntil(failedAt + resumeDelayMs).catch(
                  (): {
                    deferred: false;
                    classification: 'origin_state_persist_failed';
                  } => ({
                    deferred: false,
                    classification: 'origin_state_persist_failed',
                  }),
                );
                if (!originCooldown.deferred) {
                  originFence.retain();
                  log.error({
                    event: 'source_origin_cooldown_persist_failed',
                    classification: originCooldown.classification,
                  });
                }
                safetyStopState = await engageSourceSafetyStop(
                  sourceSafetyStop,
                  safetyReason,
                  resumeDelayMs,
                );
                if (
                  safetyStopState.stopped &&
                  safetyStopState.classification === 'marker_persist_failed'
                ) {
                  originFence.retain();
                }
                sourceDisabled = true;
                const remaining = due.slice(index + 1);
                schedule.deferThrough(remaining, eligibleAt);
                counters.sourceDeferred += remaining.length;
                log.error({
                  event: 'source_safety_stop_engaged',
                  classification: safetyStopState.stopped
                    ? safetyStopState.classification
                    : 'marker_persist_failed',
                });
                break;
              }
              const robotsFailure = fetchError.detail.startsWith(ROBOTS_DETAIL_PREFIX);
              if (robotsFailure) {
                counters.robotsSkipped += 1;
                await enqueueRobotsOperatorEpisode(
                  deps.repo,
                  debouncer,
                  classKey,
                  fetchError.detail,
                  counters.operatorAlerted,
                  log,
                );
              }
              log.error({
                event: 'source_fetch_failed',
                classKey,
                status: fetchError.status,
                retryAfterMs: fetchError.retryAfterMs,
                nextEligibleAt: new Date(eligibleAt).toISOString(),
                classification: sourceFailureClassification(fetchError),
              });

              if (fetchError.status === 429 || robotsFailure) {
                schedule.blockOrigin(eligibleAt);
                const remaining = due.slice(index + 1);
                schedule.deferThrough(remaining, eligibleAt);
                counters.sourceDeferred += remaining.length;
                break;
              }
              continue;
            }

            // Keep repository/transition failures outside the per-Section
            // source catch. Infrastructure failures must reach the owning
            // scheduler and engage its process-level backoff instead of
            // looking like a fetch failure and advancing to the next Section.
            await handleObservation({
              classKey,
              previous,
              observation,
              cycleCutoff,
              repo: deps.repo,
              schedule,
              config,
              debouncer,
              log,
              random,
              nowMs,
              counters,
              onProgress,
            });
          } finally {
            await originFence.release();
          }
        }
      } finally {
        deps.source.endCycle();
      }

      if (counters.robotsSkipped === 0) {
        for (const recoveredKey of debouncer.recoverRobots()) {
          log.info({ event: 'operator_episode_recovered', episodeKey: recoveredKey });
        }
      }
    }
  }

  const secondDrain = sourceOnly
    ? emptyDrainSummary()
    : await drainMailOutbox({
        repo: deps.repo,
        dispatcher: deps.mailDispatcher,
        config,
        logger: log,
        nowMs,
        signal,
        onProgress,
      });
  const mail = addDrainSummaries(firstDrain, secondDrain);
  const outbox = sourceOnly
    ? { queued: 0, processing: 0, deadLetter: 0, oldestQueuedAt: null }
    : await deps.repo.getMailOutboxHealth();
  if (!sourceOnly) onProgress();
  const finishedAt = nowMs();
  const sourceHealth = schedule.health(
    activeClassKeys.filter((classKey) => !counters.classGone.includes(classKey)),
    finishedAt,
    config.healthSourceMaxStaleMs,
  );
  const oldestQueuedAgeMs = outbox.oldestQueuedAt
    ? Math.max(0, finishedAt - outbox.oldestQueuedAt.getTime())
    : null;
  const outboxHealthy =
    sourceOnly ||
    (outbox.deadLetter === 0 &&
      (oldestQueuedAgeMs === null || oldestQueuedAgeMs <= config.healthOutboxMaxAgeMs));
  const nextWakeAt = sourceDisabled
    ? finishedAt + config.pollHeartbeatMs
    : schedule.nextWakeAt(
        activeClassKeys.filter((classKey) => !counters.classGone.includes(classKey)),
        finishedAt,
      );

  counters.parserBroke.sort();
  counters.classGone.sort();
  counters.operatorAlerted.sort();
  const summary: CycleSummary = {
    fetched: counters.fetched,
    parserBroke: counters.parserBroke,
    classGone: counters.classGone,
    operatorAlerted: counters.operatorAlerted,
    notified: mail.sent,
    suppressed: 0,
    addressSuppressed: mail.suppressed,
    sourceRequests: counters.sourceRequests,
    sourceNotModified: counters.sourceNotModified,
    sourceDeferred: counters.sourceDeferred,
    sourceFailures: counters.sourceFailures,
    mailClaimed: mail.claimed,
    mailSent: mail.sent,
    mailDeferred: mail.deferred,
    mailCancelledExpired: expiredAtStart + mail.cancelledExpired,
    mailDeadLettered: mail.deadLettered,
    mailClaimFenceLost: mail.claimFenceLost,
    retentionPurged,
    sourceStaleCount: sourceDisabled ? 0 : sourceHealth.staleCount,
    outboxQueued: outbox.queued,
    outboxProcessing: outbox.processing,
    outboxDeadLetter: outbox.deadLetter,
    outboxOldestQueuedAgeMs: oldestQueuedAgeMs,
    nextSourceCheckAt: nextWakeAt === null ? null : new Date(nextWakeAt).toISOString(),
    sourceDisabled,
    healthy: !sourceDisabled && sourceHealth.staleCount === 0 && outboxHealthy,
  };

  log.info({
    event: 'worker_cycle_health',
    activeClassCount: activeClassKeys.length,
    sourceRequests: summary.sourceRequests,
    sourceNotModified: summary.sourceNotModified,
    sourceDeferred: summary.sourceDeferred,
    sourceFailures: summary.sourceFailures,
    sourceStaleCount: summary.sourceStaleCount,
    mailClaimed: summary.mailClaimed,
    mailSent: summary.mailSent,
    mailDeferred: summary.mailDeferred,
    mailCancelledExpired: summary.mailCancelledExpired,
    mailDeadLettered: summary.mailDeadLettered,
    outboxQueued: summary.outboxQueued,
    outboxProcessing: summary.outboxProcessing,
    outboxDeadLetter: summary.outboxDeadLetter,
    outboxOldestQueuedAgeMs: summary.outboxOldestQueuedAgeMs,
    sourceDisabled: summary.sourceDisabled,
    healthy: summary.healthy,
  });
  return summary;
}

interface ObservationContext {
  classKey: ClassKey;
  previous: Awaited<ReturnType<RuntimeWorkerRepo['getClassState']>>;
  observation: Awaited<ReturnType<AvailabilitySource['fetch']>>;
  cycleCutoff: string;
  repo: RuntimeWorkerRepo;
  schedule: SourceScheduleState;
  config: V04WorkerConfig;
  debouncer: OperatorAlertDebouncer;
  log: V04Logger;
  random: () => number;
  nowMs: () => number;
  counters: {
    sourceNotModified: number;
    parserBroke: ClassKey[];
    classGone: ClassKey[];
    operatorAlerted: string[];
    robotsSkipped: number;
    enqueued: number;
  };
  onProgress(): void;
}

async function handleObservation(context: ObservationContext): Promise<void> {
  const {
    classKey,
    previous,
    observation,
    cycleCutoff,
    repo,
    schedule,
    config,
    debouncer,
    log,
    random,
    nowMs,
    counters,
    onProgress,
  } = context;

  if (observation.kind === 'not-modified') {
    if (!previous || !schedule.canAcceptNotModified(classKey, true)) {
      schedule.forget(classKey);
      log.error({
        event: 'source_304_rejected',
        classKey,
        reason: 'no trusted persisted representation',
      });
      return;
    }
    const sourceFreshUntil = sourceFreshUntilFromCache(observation.cache, config);
    await repo.upsertClassState({
      classKey,
      lastStatus: previous.lastStatus,
      lastOpenSeats: previous.lastOpenSeats,
      lastWaitlistOpen: previous.lastWaitlistOpen,
      displayName: previous.displayName,
      lastEnrolled: previous.lastEnrolled,
      lastCapacity: previous.lastCapacity,
      lastWaitlisted: previous.lastWaitlisted,
      lastWaitlistMax: previous.lastWaitlistMax,
      sourceFreshUntil,
    });
    onProgress();
    schedule.recordSuccessfulObservation(classKey, observation.cache, config, random);
    counters.sourceNotModified += 1;
    log.info({
      event: 'source_not_modified',
      classKey,
      checkedAt: observation.checkedAt,
      nextEligibleAt: scheduleNextIso(schedule, [classKey], nowMs()),
    });
    return;
  }

  const result = observation.result;
  if (isClassGone(result)) {
    const retiredCount = await repo.retireWatchesForClass(classKey, cycleCutoff);
    onProgress();
    schedule.forget(classKey);
    counters.classGone.push(classKey);
    log.info({ event: 'class_gone', classKey, retiredCount });
    return;
  }

  if (isParserBroke(result)) {
    schedule.recordUnparseableResponse(classKey, observation.cache, config, nowMs(), random);
    counters.parserBroke.push(classKey);
    const robots = result.detail.startsWith(ROBOTS_DETAIL_PREFIX);
    if (robots) {
      counters.robotsSkipped += 1;
      await enqueueRobotsOperatorEpisode(
        repo,
        debouncer,
        classKey,
        result.detail,
        counters.operatorAlerted,
        log,
      );
    } else {
      const episode = await repo.recordParserBroken({
        classKey,
        detail: result.detail,
      });
      onProgress();
      if (episode.status === 'opened') {
        counters.operatorAlerted.push(classKey);
        log.warn({
          event: 'operator_episode_opened',
          classKey,
          mailJobId: episode.mailJobId,
          classification: 'parser_broke',
        });
      } else {
        log.info({
          event: 'parser_broke_debounced',
          classKey,
          classification: 'parser_broke',
        });
      }
    }
    return;
  }

  const sourceFreshUntil = observation.cache
    ? sourceFreshUntilFromCache(observation.cache, config)
    : new Date(Date.parse(result.fetchedAt) + config.sourceVisibleTargetMs);
  const observedAtMs = Date.parse(result.fetchedAt);
  if (!Number.isFinite(observedAtMs)) {
    throw new Error('source returned an invalid fetchedAt timestamp');
  }

  const parserRecovered = await repo.recordParserRecovery(classKey);
  onProgress();
  if (parserRecovered) {
    log.info({
      event: 'operator_episode_recovered',
      classKey,
      classification: 'parser_recovered',
    });
  }

  const persistedFreshUntil = previous?.sourceFreshUntil?.getTime() ?? 0;
  const processFreshUntil = schedule.baselineFreshUntil(classKey) ?? 0;
  const baselineStale =
    previous !== undefined && Math.max(persistedFreshUntil, processFreshUntil) < observedAtMs;

  if (!previous || baselineStale) {
    await repo.upsertClassState({
      classKey,
      lastStatus: result.status,
      lastOpenSeats: result.openSeats,
      lastWaitlistOpen: result.waitlistOpen,
      ...dashboardObservationsForPersistence(result),
      sourceFreshUntil,
    });
    onProgress();
    log.info({
      event: previous ? 'class_rebaseline_stale' : 'class_baseline_created',
      classKey,
      status: result.status,
    });
    if (observation.cache) {
      schedule.recordSuccessfulObservation(classKey, observation.cache, config, random);
    }
    return;
  }

  const seatOpened = previous.lastOpenSeats === 0 && result.openSeats > 0;
  const waitlistOpened = !previous.lastWaitlistOpen && result.waitlistOpen;
  if (seatOpened || waitlistOpened) {
    const reason = seatOpened ? 'seats-open' : 'waitlist-open';
    const committed = await repo.commitOpeningAndEnqueueMail({
      classKey,
      previousStateVersion: previous.stateVersion,
      openedAt: result.fetchedAt,
      reason,
      openSeats: result.openSeats,
      nextState: {
        lastStatus: result.status,
        lastOpenSeats: result.openSeats,
        lastWaitlistOpen: result.waitlistOpen,
        ...dashboardObservationsForPersistence(result),
        sourceFreshUntil,
      },
    });
    onProgress();
    counters.enqueued += committed.enqueued;
    log.info({
      event: 'opening_committed',
      classKey,
      reason,
      transitioned: committed.transitioned,
      enqueued: committed.enqueued,
    });
  } else {
    await repo.upsertClassState({
      classKey,
      lastStatus: result.status,
      lastOpenSeats: result.openSeats,
      lastWaitlistOpen: result.waitlistOpen,
      ...dashboardObservationsForPersistence(result),
      sourceFreshUntil,
    });
    onProgress();
  }

  if (observation.cache) {
    schedule.recordSuccessfulObservation(classKey, observation.cache, config, random);
  }
}

async function enqueueRobotsOperatorEpisode(
  repo: RuntimeWorkerRepo,
  debouncer: OperatorAlertDebouncer,
  classKey: ClassKey,
  detail: string,
  operatorAlerted: string[],
  log: V04Logger,
): Promise<void> {
  const decision = debouncer.observeBroken(classKey, 'robots');
  if (!decision.shouldAlert || decision.reason === 'debounced') {
    log.info({
      event: 'robots_episode_debounced',
      classKey,
      episodeKey: ROBOTS_EPISODE_KEY,
      reason: decision.reason,
    });
    return;
  }

  try {
    await repo.enqueueOperatorMail({ classKey, detail });
    operatorAlerted.push(ROBOTS_EPISODE_KEY);
    log.warn({
      event: 'operator_mail_enqueued',
      classKey,
      episodeKey: ROBOTS_EPISODE_KEY,
      reason: decision.reason,
    });
  } catch (error) {
    debouncer.alertFailed(classKey, 'robots', decision.reason);
    throw error;
  }
}

interface DrainDeps {
  repo: RuntimeWorkerRepo;
  dispatcher: MailDispatcher;
  config: V04WorkerConfig;
  logger: V04Logger;
  nowMs: () => number;
  signal?: AbortSignal;
  onProgress(): void;
}

export async function drainMailOutbox(deps: DrainDeps): Promise<OutboxDrainSummary> {
  const summary = emptyDrainSummary();

  for (let batchNumber = 0; batchNumber < MAX_OUTBOX_BATCHES_PER_DRAIN; batchNumber += 1) {
    if (deps.signal?.aborted) break;
    const batch = await deps.repo.claimMailBatch({
      limit: deps.config.outboxBatchSize,
      leaseSeconds: deps.config.outboxClaimLeaseSeconds,
    });
    deps.onProgress();
    const { jobs, deadLetteredRetryHorizon } = batch;
    if (deadLetteredRetryHorizon > 0) {
      summary.deadLettered += deadLetteredRetryHorizon;
      deps.logger.error({
        event: 'mail_retry_horizon_dead_lettered',
        count: deadLetteredRetryHorizon,
      });
    }
    if (jobs.length === 0) break;
    summary.claimed += jobs.length;

    let results: Array<{ jobId: string; result: MailDispatchResult }>;
    try {
      results = await deps.dispatcher.dispatchBatch(jobs);
    } catch {
      deps.logger.error({
        event: 'mail_dispatch_batch_failed',
        count: jobs.length,
        classification: 'mail_dispatch_failed',
      });
      results = jobs.map((job) => ({
        jobId: job.id,
        result: {
          status: 'retryable',
          errorCode: 'dispatcher_batch_exception',
        },
      }));
    }
    deps.onProgress();
    const byJobId = new Map(results.map((item) => [item.jobId, item.result]));

    await mapWithConcurrency(jobs, OUTBOX_STATE_WRITE_CONCURRENCY, async (job) => {
      const result =
        byJobId.get(job.id) ??
        ({ status: 'retryable', errorCode: 'dispatcher_result_missing' } as const);
      const updated = await settleMailJob(deps, job, result, summary);
      if (!updated) {
        summary.claimFenceLost += 1;
        deps.logger.warn({
          event: 'mail_claim_fence_lost',
          jobId: job.id,
          kind: job.kind,
        });
      }
      deps.onProgress();
    });

    if (jobs.length < deps.config.outboxBatchSize) break;
  }

  return summary;
}

async function settleMailJob(
  deps: DrainDeps,
  job: MailDispatchJob,
  result: MailDispatchResult,
  summary: OutboxDrainSummary,
): Promise<boolean> {
  // Push starts independently inside the dispatcher and is deliberately not
  // part of the durable email state machine. Attach observability before any
  // claim-fenced write, for every provider outcome, but never await it or use
  // it to decide how the mail job settles.
  observePushCompletion(result, job, deps.logger);

  if (result.status === 'success') {
    const acceptedAt =
      result.acceptedAt instanceof Date && !Number.isNaN(result.acceptedAt.getTime())
        ? result.acceptedAt
        : new Date(deps.nowMs());
    const completed = await deps.repo.completeMailJob({
      id: job.id,
      claimToken: job.claimToken,
      providerAcceptedAt: acceptedAt,
      ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
    });
    if (completed) {
      summary.sent += 1;
    }
    return completed;
  }

  if (result.status === 'suppressed') {
    const cancelled = await deps.repo.cancelClaimedMailJob({
      id: job.id,
      claimToken: job.claimToken,
      reason: 'suppressed',
    });
    if (cancelled) {
      summary.suppressed += 1;
    }
    return cancelled;
  }

  if (result.status === 'permanent') {
    const deadLettered = await deps.repo.deadLetterMailJob({
      id: job.id,
      claimToken: job.claimToken,
      errorCode: boundedErrorCode(result.errorCode, 'provider_permanent_failure'),
    });
    if (deadLettered) {
      summary.deadLettered += 1;
      deps.logger.error({
        event: 'mail_dead_lettered',
        jobId: job.id,
        kind: job.kind,
        classification: 'mail_provider_permanent',
      });
    }
    return deadLettered;
  }

  const delayMs =
    result.status === 'rate-limited'
      ? Math.max(1_000, finiteNonnegative(result.retryAfterMs, 1_000))
      : Math.min(
          DEFAULT_MAIL_RETRY_BASE_MS * Math.pow(2, Math.min(Math.max(0, job.attempts - 1), 20)),
          deps.config.maxBackoffMs,
        );
  const errorCode = boundedErrorCode(result.errorCode, 'provider_retryable_failure');
  const disposition = await deps.repo.deferMailJob({
    id: job.id,
    claimToken: job.claimToken,
    availableAt: new Date(deps.nowMs() + delayMs),
    errorCode,
  });
  switch (disposition) {
    case 'deferred':
      summary.deferred += 1;
      return true;
    case 'cancelled-expired':
      summary.cancelledExpired += 1;
      deps.logger.info({
        event: 'mail_cancelled_expired',
        jobId: job.id,
        kind: job.kind,
      });
      return true;
    case 'dead-lettered-retry-horizon':
      summary.deadLettered += 1;
      deps.logger.error({
        event: 'mail_dead_lettered',
        jobId: job.id,
        kind: job.kind,
        reason: 'retry-horizon',
        classification: 'mail_retry_horizon_exhausted',
      });
      return true;
    case 'claim-fence-lost':
      return false;
  }
}

function observePushCompletion(
  result: MailDispatchResult,
  job: MailDispatchJob,
  log: V04Logger,
): void {
  if (!result.pushCompletion) return;
  const mailOutcome = result.status;
  void result.pushCompletion.then(
    (sent) => {
      log.info({ event: 'push_fanout_complete', jobId: job.id, mailOutcome, sent });
    },
    () => {
      log.error({
        event: 'push_fanout_failed',
        jobId: job.id,
        mailOutcome,
        classification: 'push_fanout_failed',
      });
    },
  );
}

function sourceTiming(
  cache: SourceCacheMetadata,
  config: V04WorkerConfig,
  random: () => number,
): {
  checkedAtMs: number;
  nextEligibleAtMs: number;
  baselineFreshUntilMs: number;
} {
  const checkedAtMs = safeTimestamp(cache.checkedAt, Date.now());
  const cacheFreshUntilMs = Math.max(checkedAtMs, safeTimestamp(cache.freshUntil, checkedAtMs));
  const jitterMs = boundedJitter(config.pollJitterMs, random);
  const targetWithoutJitterMs = Math.max(0, config.sourceVisibleTargetMs - config.pollJitterMs);
  return {
    checkedAtMs,
    nextEligibleAtMs: Math.max(cacheFreshUntilMs, checkedAtMs + targetWithoutJitterMs) + jitterMs,
    baselineFreshUntilMs: cacheFreshUntilMs + config.sourceVisibleTargetMs,
  };
}

function sourceFreshUntilFromCache(cache: SourceCacheMetadata, config: V04WorkerConfig): Date {
  const checkedAtMs = safeTimestamp(cache.checkedAt, Date.now());
  const freshUntilMs = Math.max(checkedAtMs, safeTimestamp(cache.freshUntil, checkedAtMs));
  return new Date(freshUntilMs + config.sourceVisibleTargetMs);
}

function validatorsFromCache(cache: SourceCacheMetadata): SourceValidators | undefined {
  const validators: SourceValidators = {
    ...(cache.etag ? { etag: cache.etag } : {}),
    ...(cache.lastModified ? { lastModified: cache.lastModified } : {}),
  };
  return validators.etag || validators.lastModified ? validators : undefined;
}

function scheduleNextIso(
  schedule: SourceScheduleState,
  classKeys: readonly ClassKey[],
  nowMs: number,
): string | null {
  const next = schedule.nextWakeAt(classKeys, nowMs);
  return next === null ? null : new Date(next).toISOString();
}

function retentionCount(result: RetentionSweepResult): number {
  return (
    result.pendingSubscribers +
    result.terminalMailJobs +
    result.legacyAlertDeliveries +
    result.retiredWatches +
    result.orphanedClassStates +
    result.expiredMailJobs
  );
}

function emptyDrainSummary(): OutboxDrainSummary {
  return {
    claimed: 0,
    sent: 0,
    suppressed: 0,
    deferred: 0,
    cancelledExpired: 0,
    deadLettered: 0,
    claimFenceLost: 0,
  };
}

function addDrainSummaries(
  left: OutboxDrainSummary,
  right: OutboxDrainSummary,
): OutboxDrainSummary {
  return {
    claimed: left.claimed + right.claimed,
    sent: left.sent + right.sent,
    suppressed: left.suppressed + right.suppressed,
    deferred: left.deferred + right.deferred,
    cancelledExpired: left.cancelledExpired + right.cancelledExpired,
    deadLettered: left.deadLettered + right.deadLettered,
    claimFenceLost: left.claimFenceLost + right.claimFenceLost,
  };
}

function boundedJitter(maxMs: number, random: () => number): number {
  if (maxMs <= 0) return 0;
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return Math.floor(normalized * maxMs);
}

function finiteNonnegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function safeTimestamp(raw: string, fallback: number): number {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedErrorCode(value: string, fallback: string): string {
  return /^[a-z0-9_.:-]{1,128}$/.test(value) ? value : fallback;
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const value = values[cursor];
      cursor += 1;
      if (value === undefined) return;
      await task(value);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()),
  );
}

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonnegativeIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function boundedIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = positiveIntegerEnv(env, name, fallback);
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function positiveNumberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

interface CombinedAbortSignal {
  signal: AbortSignal;
  dispose(): void;
}

function combineAbortSignals(
  outerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal,
): CombinedAbortSignal {
  if (outerSignal === undefined || outerSignal === requestSignal) {
    return { signal: requestSignal, dispose: () => undefined };
  }

  const controller = new AbortController();
  const signals = [outerSignal, requestSignal];
  const abort = (): void => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      for (const signal of signals) signal.removeEventListener('abort', abort);
    },
  };
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

export async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function defaultLogger(): V04Logger {
  function emit(level: 'info' | 'warn' | 'error', obj: Record<string, unknown>): void {
    const line = `${JSON.stringify({ level, ...obj })}\n`;
    if (level === 'error') process.stderr.write(line);
    else process.stdout.write(line);
  }
  return {
    info: (obj) => emit('info', obj),
    warn: (obj) => emit('warn', obj),
    error: (obj) => emit('error', obj),
  };
}

function safetyStopReason(error: FetchError): SourceSafetyStopReason | null {
  switch (error.kind) {
    case 'robots-disallow':
      return 'robots_disallow';
    case 'source-forbidden':
      return 'source_forbidden';
    case 'source-rate-limited':
      return 'source_rate_limited';
    case 'transient':
      return null;
  }
}

async function inspectSourceSafetyStop(
  store: SourceSafetyStopStore,
): Promise<SourceSafetyStopState> {
  try {
    return await store.inspect();
  } catch {
    return { stopped: true, classification: 'marker_unreadable' };
  }
}

async function engageSourceSafetyStop(
  store: SourceSafetyStopStore,
  reason: SourceSafetyStopReason,
  resumeDelayMs: number,
): Promise<SourceSafetyStopState> {
  try {
    const state = await store.engage(reason, { resumeDelayMs });
    return state.stopped ? state : { stopped: true, classification: 'marker_persist_failed' };
  } catch {
    return { stopped: true, classification: 'marker_persist_failed' };
  }
}

function sourceFailureClassification(error: FetchError): string {
  if (error.kind === 'robots-disallow') return 'robots_disallow';
  if (error.kind === 'source-forbidden') return 'source_forbidden';
  if (error.kind === 'source-rate-limited') return 'source_rate_limited';
  if (error.detail.startsWith(ROBOTS_DETAIL_PREFIX)) return 'robots_unavailable';
  if (error.status >= 500) return 'source_http_transient';
  if (error.status === 0) return 'source_network_failure';
  return 'source_request_failed';
}

function incidentOutcomeClassification(status: ProviderOutcome['status']): string {
  switch (status) {
    case 'success':
      return 'incident_provider_accepted';
    case 'rate-limited':
      return 'incident_provider_rate_limited';
    case 'retryable':
      return 'incident_provider_retryable';
    case 'permanent':
      return 'incident_provider_permanent';
  }
}
