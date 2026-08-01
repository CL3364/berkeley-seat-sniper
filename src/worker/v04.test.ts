import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MailDispatchJob, MailDispatcher } from '../notify';
import type { MailClaimBatch, MailDeferDisposition } from '../db';
import { FetchError, type AvailabilitySource, type OriginPermitContext } from '../scraper';
import type { ClassKey } from '../shared/class-key';
import {
  drainMailOutboxOnce,
  readV04WorkerConfig,
  runCacheAwarePollCycle,
  SourceScheduleState,
  type V04Logger,
} from './v04';
import {
  createFileSourceSafetyStopStore,
  createMemorySourceSafetyStopStore,
  SOURCE_SAFETY_STOP_RESET_CONFIRMATION,
  type SourceSafetyStopReason,
  type SourceSafetyStopStore,
} from './source-safety-stop';
import { createFileSourceOriginControl } from './source-origin-control';
import type { RuntimeWorkerRepo } from './types';

const CREATED_AT = new Date('2026-07-24T00:00:00.000Z');
const TEST_EMAIL = 'worker-disposition@berkeley.edu';
const CLASS_KEY = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const SECOND_CLASS_KEY = '2026-fall-compsci-189-002-lec-001' as ClassKey;
const THIRD_CLASS_KEY = '2026-fall-compsci-189-003-lec-001' as ClassKey;
let originalKillSwitch: string | undefined;

beforeEach(() => {
  originalKillSwitch = process.env['KILL_SWITCH'];
  process.env['KILL_SWITCH'] = '0';
});

afterEach(() => {
  if (originalKillSwitch === undefined) delete process.env['KILL_SWITCH'];
  else process.env['KILL_SWITCH'] = originalKillSwitch;
});

function mailJob(): MailDispatchJob {
  return {
    id: 'mail-job-1',
    claimToken: 'claim-token-1',
    kind: 'confirmation',
    subscriberId: 'subscriber-1',
    email: TEST_EMAIL,
    subscriberConfirmed: false,
    classKey: null,
    openedAt: null,
    reason: null,
    attempts: 1,
    expiresAt: null,
    providerIdempotencyKey: 'provider-key-1',
    payload: {},
    createdAt: CREATED_AT,
  };
}

function retryingDispatcher(): MailDispatcher {
  return {
    async dispatch() {
      return { status: 'retryable', errorCode: 'provider_unavailable' };
    },
    async dispatchBatch(jobs) {
      return jobs.map((job) => ({
        jobId: job.id,
        result: { status: 'retryable', errorCode: 'provider_unavailable' },
      }));
    },
    outbox: [],
  };
}

function logger(): V04Logger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function repoFor(
  claim: MailClaimBatch,
  disposition: MailDeferDisposition = 'deferred',
): RuntimeWorkerRepo {
  return {
    async claimMailBatch() {
      return claim;
    },
    async deferMailJob() {
      return disposition;
    },
  } as unknown as RuntimeWorkerRepo;
}

function cycleRepo(classKeys: ClassKey[] = [CLASS_KEY]): RuntimeWorkerRepo {
  return {
    async getDistinctWatchedClassKeys() {
      return classKeys;
    },
    async getPollCycleCutoff() {
      return CREATED_AT.toISOString();
    },
    async getClassState() {
      return undefined;
    },
    async expireMailOutboxAlerts() {
      return 0;
    },
    async claimMailBatch() {
      return { jobs: [], deadLetteredRetryHorizon: 0 };
    },
    async sweepRetention() {
      return {
        pendingSubscribers: 0,
        terminalMailJobs: 0,
        legacyAlertDeliveries: 0,
        retiredWatches: 0,
        orphanedClassStates: 0,
        expiredMailJobs: 0,
      };
    },
    async getMailOutboxHealth() {
      return { queued: 0, processing: 0, deadLetter: 0, oldestQueuedAt: null };
    },
    async enqueueOperatorMail() {
      return 'operator-mail-1';
    },
  } as unknown as RuntimeWorkerRepo;
}

describe('v0.4 durable mail disposition accounting', () => {
  it('counts jobs terminalized at claim time as retry-horizon dead letters', async () => {
    const log = logger();
    const summary = await drainMailOutboxOnce({
      repo: repoFor({ jobs: [], deadLetteredRetryHorizon: 2 }),
      dispatcher: retryingDispatcher(),
      logger: log,
    });

    expect(summary).toMatchObject({
      claimed: 0,
      deferred: 0,
      cancelledExpired: 0,
      deadLettered: 2,
      claimFenceLost: 0,
    });
    expect(log.error).toHaveBeenCalledWith({
      event: 'mail_retry_horizon_dead_lettered',
      count: 2,
    });
  });

  it.each([
    {
      disposition: 'deferred' as const,
      expected: { deferred: 1, cancelledExpired: 0, deadLettered: 0, claimFenceLost: 0 },
    },
    {
      disposition: 'cancelled-expired' as const,
      expected: { deferred: 0, cancelledExpired: 1, deadLettered: 0, claimFenceLost: 0 },
    },
    {
      disposition: 'dead-lettered-retry-horizon' as const,
      expected: { deferred: 0, cancelledExpired: 0, deadLettered: 1, claimFenceLost: 0 },
    },
    {
      disposition: 'claim-fence-lost' as const,
      expected: { deferred: 0, cancelledExpired: 0, deadLettered: 0, claimFenceLost: 1 },
    },
  ])('classifies a defer result of $disposition', async ({ disposition, expected }) => {
    const log = logger();
    const summary = await drainMailOutboxOnce({
      repo: repoFor(
        {
          jobs: [mailJob()],
          deadLetteredRetryHorizon: 0,
        },
        disposition,
      ),
      dispatcher: retryingDispatcher(),
      logger: log,
      nowMs: () => CREATED_AT.getTime(),
    });

    expect(summary).toMatchObject({ claimed: 1, ...expected });
    expect(
      JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]),
    ).not.toContain(TEST_EMAIL);
  });
});

describe('v0.4 source configuration and opt-in', () => {
  it('accepts positive fractional source rates and rejects rates above one', () => {
    expect(
      readV04WorkerConfig({ SOURCE_REQUESTS_PER_SECOND: '0.0166666667' }).sourceRequestsPerSecond,
    ).toBeCloseTo(1 / 60);
    expect(() => readV04WorkerConfig({ SOURCE_REQUESTS_PER_SECOND: '1.0001' })).toThrow(
      'SOURCE_REQUESTS_PER_SECOND must be at most 1',
    );
  });

  it.each([
    { label: 'missing', value: undefined },
    { label: 'empty', value: '' },
    { label: 'one', value: '1' },
    { label: 'true', value: 'true' },
    { label: 'eleven', value: '11' },
    { label: 'whitespace', value: ' 0 ' },
  ])('fails closed when KILL_SWITCH is $label', async ({ value }) => {
    if (value === undefined) delete process.env['KILL_SWITCH'];
    else process.env['KILL_SWITCH'] = value;
    const source: AvailabilitySource = {
      fetch: vi.fn(),
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };

    const summary = await runCacheAwarePollCycle({
      repo: cycleRepo(),
      source,
      mailDispatcher: retryingDispatcher(),
      sourceOnly: true,
      logger: logger(),
    });

    expect(source.fetch).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      sourceRequests: 0,
      sourceDisabled: true,
      healthy: false,
    });
  });
});

describe('v0.4 actual origin request permits', () => {
  it('makes zero source requests while another worker owns the durable fence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seat-sniper-origin-overlap-'));
    const path = join(directory, 'origin-state.json');
    const firstOwner = createFileSourceOriginControl({ path });
    const secondOwner = createFileSourceOriginControl({ path });
    const owned = await firstOwner.acquireFence();
    if (!owned.acquired) throw new Error('first worker did not acquire the fence');
    const source: AvailabilitySource = {
      fetch: vi.fn(),
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };

    try {
      const summary = await runCacheAwarePollCycle({
        repo: cycleRepo(),
        source,
        mailDispatcher: retryingDispatcher(),
        sourceOriginControl: secondOwner,
        logger: logger(),
      });

      expect(source.fetch).not.toHaveBeenCalled();
      expect(summary).toMatchObject({
        sourceRequests: 0,
        sourceDeferred: 1,
        sourceDisabled: true,
        healthy: false,
      });
    } finally {
      await owned.fence.release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('enters the source before waiting and counts every successful physical-request permit', async () => {
    let currentMs = 0;
    const events: string[] = [];
    const schedule = new SourceScheduleState();
    const config = {
      ...readV04WorkerConfig({}),
      pollJitterMs: 0,
      sourceRequestsPerSecond: 1,
    };
    const sleep = vi.fn(async (milliseconds: number) => {
      events.push(`sleep:${milliseconds}`);
      currentMs += milliseconds;
    });
    await schedule.waitForOriginPermit(config, () => currentMs, sleep);
    sleep.mockClear();

    const source: AvailabilitySource = {
      async fetch(_classKey, request) {
        events.push('source:fetch');
        const runWithPermit = request?.runWithOriginPermit;
        if (!runWithPermit) throw new Error('missing actual-request permit');
        for (const kind of ['robots', 'class', 'class'] as const) {
          const started = await runWithPermit(
            { kind, signal: new AbortController().signal },
            () => {
              events.push(`permit:${kind}`);
              return { started: Promise.resolve() };
            },
          );
          await started.started;
        }
        throw new FetchError(503, 'simulated source failure');
      },
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };

    const summary = await runCacheAwarePollCycle({
      repo: cycleRepo(),
      source,
      mailDispatcher: retryingDispatcher(),
      schedule,
      config,
      logger: logger(),
      nowMs: () => currentMs,
      random: () => 0,
      sleep,
    });

    expect(summary.sourceRequests).toBe(3);
    expect(summary.sourceFailures).toBe(1);
    expect(events).toEqual([
      'source:fetch',
      'sleep:1000',
      'permit:robots',
      'sleep:1000',
      'permit:class',
      'sleep:1000',
      'permit:class',
    ]);
  });

  it.each(['outer', 'request'] as const)(
    'aborts a pending actual-request permit from the %s signal without counting it',
    async (abortingSignal) => {
      const currentMs = 0;
      const schedule = new SourceScheduleState();
      const config = {
        ...readV04WorkerConfig({}),
        pollJitterMs: 0,
        sourceRequestsPerSecond: 1,
      };
      await schedule.waitForOriginPermit(
        config,
        () => currentMs,
        async () => undefined,
      );

      const outerController = new AbortController();
      const requestController = new AbortController();
      let combinedSignal: AbortSignal | undefined;
      let permitError: unknown;
      const sleep = vi.fn(async (_milliseconds: number, signal?: AbortSignal) => {
        combinedSignal = signal;
        if (abortingSignal === 'outer') outerController.abort();
        else requestController.abort();
      });
      const source: AvailabilitySource = {
        async fetch(_classKey, request) {
          const runWithPermit = request?.runWithOriginPermit;
          if (!runWithPermit) throw new Error('missing actual-request permit');
          try {
            await runWithPermit(
              {
                kind: 'class',
                signal: requestController.signal,
              } satisfies OriginPermitContext,
              () => {
                throw new Error('physical request unexpectedly started');
              },
            );
          } catch (error) {
            permitError = error;
            throw error;
          }
          throw new Error('permit unexpectedly succeeded');
        },
        beginCycle: vi.fn(),
        endCycle: vi.fn(),
      };

      const summary = await runCacheAwarePollCycle({
        repo: cycleRepo(),
        source,
        mailDispatcher: retryingDispatcher(),
        schedule,
        config,
        logger: logger(),
        nowMs: () => currentMs,
        random: () => 0,
        sleep,
        signal: outerController.signal,
      });

      expect(summary.sourceRequests).toBe(0);
      expect(permitError).toMatchObject({ name: 'AbortError' });
      expect(combinedSignal).toBeInstanceOf(AbortSignal);
      expect(combinedSignal?.aborted).toBe(true);
      expect(combinedSignal).not.toBe(outerController.signal);
      expect(combinedSignal).not.toBe(requestController.signal);
    },
  );
});

describe('v0.4 source-safety stop', () => {
  it('retains the fence and 429 cooldown when the safety marker cannot persist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seat-sniper-origin-retained-'));
    const path = join(directory, 'origin-state.json');
    let currentMs = Date.parse('2026-07-27T21:59:59.000Z');
    const originControl = createFileSourceOriginControl({
      path,
      nowMs: () => currentMs,
    });
    const safetyStop: SourceSafetyStopStore = {
      async inspect() {
        return { stopped: false };
      },
      async engage() {
        return { stopped: true, classification: 'marker_persist_failed' };
      },
      async reset() {
        return undefined;
      },
    };
    const source: AvailabilitySource = {
      async fetch(_classKey, request) {
        const runWithPermit = request?.runWithOriginPermit;
        if (!runWithPermit) throw new Error('missing origin permit');
        const started = await runWithPermit(
          { kind: 'class', signal: new AbortController().signal },
          () => ({ started: Promise.resolve() }),
        );
        await started.started;
        throw new FetchError(429, 'fixed synthetic safety trigger', null, 'source-rate-limited');
      },
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };

    try {
      const summary = await runCacheAwarePollCycle({
        repo: cycleRepo(),
        source,
        mailDispatcher: retryingDispatcher(),
        sourceSafetyStop: safetyStop,
        sourceOriginControl: originControl,
        config: {
          ...readV04WorkerConfig({}),
          pollJitterMs: 0,
          sourceRequestsPerSecond: 1,
        },
        logger: logger(),
        nowMs: () => currentMs,
        random: () => 0,
        sleep: async (milliseconds) => {
          currentMs += milliseconds;
        },
      });

      expect(summary).toMatchObject({
        sourceRequests: 1,
        sourceDisabled: true,
        healthy: false,
      });
      await expect(createFileSourceOriginControl({ path }).acquireFence()).resolves.toEqual({
        acquired: false,
        classification: 'origin_fence_active',
      });
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        version: 2,
        lastPermitAt: '2026-07-27T22:00:00.000Z',
        notBefore: '2026-07-27T22:00:30.000Z',
        notBeforeSetAt: '2026-07-27T22:00:00.000Z',
      });

      // Even an explicit Operator fence reset must preserve the computed
      // cooldown when the primary safety marker could not be written.
      await originControl.clearFence();
      const restarted = createFileSourceOriginControl({
        path,
        nowMs: () => currentMs,
      });
      const restartedOwner = await restarted.acquireFence();
      if (!restartedOwner.acquired) throw new Error('restarted owner did not acquire the fence');
      const sleep = vi.fn(async (milliseconds: number) => {
        currentMs += milliseconds;
      });
      await expect(
        restartedOwner.fence.runWithPermit(
          {
            requestsPerSecond: 1,
            nowMs: () => currentMs,
            sleep,
            beforeStart: async () => true,
          },
          () => undefined,
        ),
      ).resolves.toEqual({ status: 'started', value: undefined });
      expect(sleep).toHaveBeenCalledWith(30_000, undefined);
      await restartedOwner.fence.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'without Retry-After',
      retryAfterMs: null,
      expectedResumeNotBefore: '2026-07-27T22:00:30.000Z',
    },
    {
      label: 'with a longer Retry-After',
      retryAfterMs: 90_000,
      expectedResumeNotBefore: '2026-07-27T22:01:30.000Z',
    },
  ])(
    'persists computed backoff for a 429 $label',
    async ({ retryAfterMs, expectedResumeNotBefore }) => {
      const directory = await mkdtemp(join(tmpdir(), 'seat-sniper-rate-limit-stop-'));
      const safetyPath = join(directory, 'source-safety-stop.json');
      const originPath = join(directory, 'origin-state.json');
      const stoppedAtMs = Date.parse('2026-07-27T22:00:00.000Z');
      let currentMs = stoppedAtMs - 1_000;
      const originControl = createFileSourceOriginControl({
        path: originPath,
        nowMs: () => currentMs,
      });
      const safetyStop = createFileSourceSafetyStopStore({
        path: safetyPath,
        now: () => new Date(currentMs),
        originControl,
      });
      const source: AvailabilitySource = {
        async fetch(_classKey, request) {
          const runWithPermit = request?.runWithOriginPermit;
          if (!runWithPermit) throw new Error('missing origin permit');
          const started = await runWithPermit(
            { kind: 'class', signal: new AbortController().signal },
            () => ({ started: Promise.resolve() }),
          );
          await started.started;
          throw new FetchError(
            429,
            'fixed synthetic rate limit',
            retryAfterMs,
            'source-rate-limited',
          );
        },
        beginCycle: vi.fn(),
        endCycle: vi.fn(),
      };

      try {
        const summary = await runCacheAwarePollCycle({
          repo: cycleRepo(),
          source,
          mailDispatcher: retryingDispatcher(),
          sourceSafetyStop: safetyStop,
          sourceOriginControl: originControl,
          config: {
            ...readV04WorkerConfig({}),
            pollHeartbeatMs: 30_000,
            pollJitterMs: 0,
          },
          logger: logger(),
          nowMs: () => currentMs,
          random: () => 0,
          sleep: async (milliseconds) => {
            currentMs += milliseconds;
          },
        });

        expect(summary.sourceDisabled).toBe(true);
        expect(JSON.parse(await readFile(safetyPath, 'utf8'))).toMatchObject({
          version: 2,
          reason: 'source_rate_limited',
          stoppedAt: '2026-07-27T22:00:00.000Z',
          resumeNotBefore: expectedResumeNotBefore,
        });
        const restarted = createFileSourceSafetyStopStore({
          path: safetyPath,
          now: () => new Date(currentMs),
          originControl: createFileSourceOriginControl({
            path: originPath,
            nowMs: () => currentMs,
          }),
        });
        await expect(restarted.reset(SOURCE_SAFETY_STOP_RESET_CONFIRMATION)).rejects.toThrow(
          'reset deferred',
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      kind: 'robots-disallow' as const,
      status: 0,
      reason: 'robots_disallow' as SourceSafetyStopReason,
    },
    {
      kind: 'source-forbidden' as const,
      status: 403,
      reason: 'source_forbidden' as SourceSafetyStopReason,
    },
    {
      kind: 'source-rate-limited' as const,
      status: 429,
      reason: 'source_rate_limited' as SourceSafetyStopReason,
    },
  ])('latches $kind and aborts every remaining source fetch', async ({ kind, status, reason }) => {
    const store = createMemorySourceSafetyStopStore();
    const fetch = vi.fn(async () => {
      throw new FetchError(status, 'fixed synthetic safety trigger', null, kind);
    });
    const source: AvailabilitySource = {
      fetch,
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };
    const classKeys = [CLASS_KEY, SECOND_CLASS_KEY, THIRD_CLASS_KEY];
    const log = logger();

    const first = await runCacheAwarePollCycle({
      repo: cycleRepo(classKeys),
      source,
      mailDispatcher: retryingDispatcher(),
      sourceSafetyStop: store,
      logger: log,
      random: () => 0,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      fetched: 0,
      sourceFailures: 1,
      sourceDeferred: 2,
      sourceDisabled: true,
      healthy: false,
    });
    await expect(store.inspect()).resolves.toEqual({
      stopped: true,
      classification: reason,
    });
    expect(log.error).toHaveBeenCalledWith({
      event: 'source_safety_stop_engaged',
      classification: reason,
    });

    fetch.mockClear();
    const secondSource: AvailabilitySource = {
      fetch,
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };
    const second = await runCacheAwarePollCycle({
      repo: cycleRepo(classKeys),
      source: secondSource,
      mailDispatcher: retryingDispatcher(),
      sourceSafetyStop: store,
      logger: logger(),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(secondSource.beginCycle).not.toHaveBeenCalled();
    expect(second).toMatchObject({
      sourceRequests: 0,
      sourceDisabled: true,
      healthy: false,
    });
  });

  it('re-inspects the marker after an origin-permit wait and blocks the physical request', async () => {
    let currentMs = 0;
    const store = createMemorySourceSafetyStopStore();
    const schedule = new SourceScheduleState();
    const config = {
      ...readV04WorkerConfig({}),
      pollJitterMs: 0,
      sourceRequestsPerSecond: 1,
    };
    await schedule.waitForOriginPermit(
      config,
      () => currentMs,
      async () => undefined,
    );
    let physicalRequests = 0;
    const fetch = vi.fn<AvailabilitySource['fetch']>(async (classKey, request) => {
      const runWithPermit = request?.runWithOriginPermit;
      if (!runWithPermit) throw new Error('missing origin permit');
      const started = await runWithPermit(
        { kind: 'class', signal: new AbortController().signal },
        () => {
          physicalRequests += 1;
          return { started: Promise.resolve() };
        },
      );
      await started.started;
      return {
        kind: 'result',
        result: {
          classKey,
          status: 'closed',
          openSeats: 0,
          waitlistOpen: false,
          fetchedAt: CREATED_AT.toISOString(),
        },
        cache: null,
      };
    });
    const source: AvailabilitySource = {
      fetch,
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };
    const log = logger();

    const summary = await runCacheAwarePollCycle({
      repo: cycleRepo([CLASS_KEY, SECOND_CLASS_KEY]),
      source,
      mailDispatcher: retryingDispatcher(),
      sourceSafetyStop: store,
      schedule,
      config,
      logger: log,
      nowMs: () => currentMs,
      sleep: async (milliseconds) => {
        await store.engage('source_forbidden');
        currentMs += milliseconds;
      },
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(physicalRequests).toBe(0);
    expect(summary).toMatchObject({
      sourceRequests: 0,
      sourceFailures: 0,
      sourceDeferred: 2,
      sourceDisabled: true,
      healthy: false,
    });
    expect(log.warn).toHaveBeenCalledWith({
      event: 'source_cycle_interrupted',
      classification: 'source_forbidden',
    });
  });

  it('blocks a redirect permit after another owner engages the marker', async () => {
    const store = createMemorySourceSafetyStopStore();
    const engage = vi.spyOn(store, 'engage');
    let physicalRequests = 0;
    const fetch = vi.fn<AvailabilitySource['fetch']>(async (classKey, request) => {
      const runWithPermit = request?.runWithOriginPermit;
      if (!runWithPermit) throw new Error('missing origin permit');
      const first = await runWithPermit(
        { kind: 'class', signal: new AbortController().signal },
        () => {
          physicalRequests += 1;
          return { started: Promise.resolve() };
        },
      );
      await first.started;
      await store.engage('robots_disallow');
      const second = await runWithPermit(
        { kind: 'class', signal: new AbortController().signal },
        () => {
          physicalRequests += 1;
          return { started: Promise.resolve() };
        },
      );
      await second.started;
      return {
        kind: 'result',
        result: {
          classKey,
          status: 'closed',
          openSeats: 0,
          waitlistOpen: false,
          fetchedAt: CREATED_AT.toISOString(),
        },
        cache: null,
      };
    });
    const source: AvailabilitySource = {
      fetch,
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };

    const summary = await runCacheAwarePollCycle({
      repo: cycleRepo([CLASS_KEY, SECOND_CLASS_KEY]),
      source,
      mailDispatcher: retryingDispatcher(),
      sourceSafetyStop: store,
      config: {
        ...readV04WorkerConfig({}),
        pollJitterMs: 0,
        sourceRequestsPerSecond: 1,
      },
      logger: logger(),
      sleep: async () => undefined,
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(physicalRequests).toBe(1);
    expect(engage).toHaveBeenCalledOnce();
    expect(summary).toMatchObject({
      sourceRequests: 1,
      sourceFailures: 0,
      sourceDeferred: 2,
      sourceDisabled: true,
      healthy: false,
    });
  });

  it('re-reads KILL_SWITCH between redirect permits without creating a marker', async () => {
    const previousKillSwitch = process.env['KILL_SWITCH'];
    process.env['KILL_SWITCH'] = '0';
    const store = createMemorySourceSafetyStopStore();
    const engage = vi.spyOn(store, 'engage');
    let physicalRequests = 0;
    const fetch = vi.fn<AvailabilitySource['fetch']>(async (classKey, request) => {
      const runWithPermit = request?.runWithOriginPermit;
      if (!runWithPermit) throw new Error('missing origin permit');
      const first = await runWithPermit(
        { kind: 'class', signal: new AbortController().signal },
        () => {
          physicalRequests += 1;
          return { started: Promise.resolve() };
        },
      );
      await first.started;
      process.env['KILL_SWITCH'] = 'true';
      const second = await runWithPermit(
        { kind: 'class', signal: new AbortController().signal },
        () => {
          physicalRequests += 1;
          return { started: Promise.resolve() };
        },
      );
      await second.started;
      return {
        kind: 'result',
        result: {
          classKey,
          status: 'closed',
          openSeats: 0,
          waitlistOpen: false,
          fetchedAt: CREATED_AT.toISOString(),
        },
        cache: null,
      };
    });
    const source: AvailabilitySource = {
      fetch,
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };
    const log = logger();

    try {
      const summary = await runCacheAwarePollCycle({
        repo: cycleRepo([CLASS_KEY, SECOND_CLASS_KEY]),
        source,
        mailDispatcher: retryingDispatcher(),
        sourceSafetyStop: store,
        config: {
          ...readV04WorkerConfig({}),
          pollJitterMs: 0,
          sourceRequestsPerSecond: 1,
        },
        logger: log,
        sleep: async () => undefined,
      });

      expect(fetch).toHaveBeenCalledOnce();
      expect(physicalRequests).toBe(1);
      expect(engage).not.toHaveBeenCalled();
      await expect(store.inspect()).resolves.toEqual({ stopped: false });
      expect(summary).toMatchObject({
        sourceRequests: 1,
        sourceFailures: 0,
        sourceDeferred: 2,
        sourceDisabled: true,
        healthy: false,
      });
      expect(log.warn).toHaveBeenCalledWith({
        event: 'source_cycle_interrupted',
        classification: 'kill_switch_active',
      });
    } finally {
      if (previousKillSwitch === undefined) delete process.env['KILL_SWITCH'];
      else process.env['KILL_SWITCH'] = previousKillSwitch;
    }
  });

  it('does not latch a transient robots failure', async () => {
    const store = createMemorySourceSafetyStopStore();
    const fetch = vi.fn(async () => {
      throw new FetchError(
        503,
        'robots.txt: server error (503) — skipping fetch this cycle',
        null,
        'transient',
      );
    });
    const source: AvailabilitySource = {
      fetch,
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const summary = await runCacheAwarePollCycle({
        repo: cycleRepo([CLASS_KEY, SECOND_CLASS_KEY]),
        source,
        mailDispatcher: retryingDispatcher(),
        sourceSafetyStop: store,
        schedule: new SourceScheduleState(),
        logger: logger(),
        random: () => 0,
      });
      expect(summary.sourceDisabled).toBe(false);
    }

    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(store.inspect()).resolves.toEqual({ stopped: false });
  });

  it('keeps outbox and retention work running while a source marker disables fetching', async () => {
    const store = createMemorySourceSafetyStopStore({
      stopped: true,
      classification: 'robots_disallow',
    });
    const repo = cycleRepo();
    const expire = vi.spyOn(repo, 'expireMailOutboxAlerts');
    const sweep = vi.spyOn(repo, 'sweepRetention');
    const source: AvailabilitySource = {
      fetch: vi.fn(),
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };

    const summary = await runCacheAwarePollCycle({
      repo,
      source,
      mailDispatcher: retryingDispatcher(),
      sourceSafetyStop: store,
      logger: logger(),
    });

    expect(expire).toHaveBeenCalledOnce();
    expect(sweep).toHaveBeenCalledOnce();
    expect(source.fetch).not.toHaveBeenCalled();
    expect(source.beginCycle).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      sourceRequests: 0,
      sourceDisabled: true,
      healthy: false,
    });
  });
});
