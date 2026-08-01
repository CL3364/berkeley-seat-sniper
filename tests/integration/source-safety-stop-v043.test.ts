import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmSubscriber, makeRepo, makeTestDb, type Db } from '../../src/db';
import type { MailDispatcher } from '../../src/notify';
import {
  FetchError,
  createPublicClassPageSource,
  type AvailabilitySource,
  type SourceCacheMetadata,
} from '../../src/scraper';
import type { ClassKey } from '../../src/shared/class-key';
import {
  SOURCE_SAFETY_STOP_RESET_CONFIRMATION,
  SourceScheduleState,
  createFileSourceSafetyStopStore,
  createMaintenanceState,
  createWorkerRepo,
  readV04WorkerConfig,
  resetSourceSafetyStop,
  runSourcePollCycle,
  type SourceSafetyStopReason,
  type SourceSafetyStopStore,
  type V04Logger,
  type V04WorkerConfig,
} from '../../src/worker/public';

const FIRST_CLASS = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const SECOND_CLASS = '2026-fall-compsci-189-002-dis-201' as ClassKey;
const NOW_ISO = '2026-07-27T22:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

const temporaryDirectories: string[] = [];
let originalKillSwitch: string | undefined;
let originalRespectRobots: string | undefined;

beforeEach(() => {
  originalKillSwitch = process.env.KILL_SWITCH;
  originalRespectRobots = process.env.RESPECT_ROBOTS;
  process.env.KILL_SWITCH = '0';
  delete process.env.RESPECT_ROBOTS;
});

afterEach(() => {
  if (originalKillSwitch === undefined) delete process.env.KILL_SWITCH;
  else process.env.KILL_SWITCH = originalKillSwitch;
  if (originalRespectRobots === undefined) delete process.env.RESPECT_ROBOTS;
  else process.env.RESPECT_ROBOTS = originalRespectRobots;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function safetyStopPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seat-sniper-source-stop-'));
  temporaryDirectories.push(directory);
  return join(directory, 'source-safety-stop.json');
}

async function dbWithTwoConfirmedSections(): Promise<Db> {
  const db = await makeTestDb();
  const subscriber = await makeRepo(db).createSubscriber('source-stop-test@berkeley.edu', [
    FIRST_CLASS,
    SECOND_CLASS,
  ]);
  expect(await confirmSubscriber(db, subscriber.id)).toBe('confirmed');
  return db;
}

function logger(): V04Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function workerConfig(overrides: Partial<V04WorkerConfig> = {}): V04WorkerConfig {
  return {
    ...readV04WorkerConfig({}),
    pollJitterMs: 0,
    sourceRequestsPerSecond: 1,
    ...overrides,
  };
}

function unusedMailDispatcher(): MailDispatcher {
  return {
    async dispatch() {
      throw new Error('source-only cycle reached mail dispatch');
    },
    async dispatchBatch() {
      throw new Error('source-only cycle reached mail dispatch');
    },
    outbox: [],
  };
}

function cacheAt(checkedAt: string): SourceCacheMetadata {
  return {
    checkedAt,
    cacheControl: 'max-age=0',
    ageSeconds: 0,
    maxAgeSeconds: 0,
    freshForSeconds: 0,
    freshUntil: checkedAt,
    etag: '"source-safety-fixture"',
    lastModified: null,
  };
}

type SpiedSource = AvailabilitySource & {
  beginCycle: ReturnType<typeof vi.fn>;
  endCycle: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn<AvailabilitySource['fetch']>>;
};

function sourceThrowing(errorFactory: () => FetchError): SpiedSource {
  const beginCycle = vi.fn();
  const endCycle = vi.fn();
  const fetch = vi.fn<AvailabilitySource['fetch']>(async (_classKey, request) => {
    const runWithPermit = request?.runWithOriginPermit;
    if (!runWithPermit) throw new Error('source cycle omitted the physical-request permit');
    const started = await runWithPermit(
      { kind: 'class', signal: new AbortController().signal },
      () => ({ started: Promise.resolve() }),
    );
    await started.started;
    throw errorFactory();
  });
  return { beginCycle, endCycle, fetch };
}

function successfulSource(onStart: () => void = () => undefined): SpiedSource {
  const beginCycle = vi.fn();
  const endCycle = vi.fn();
  const fetch = vi.fn<AvailabilitySource['fetch']>(async (classKey, request) => {
    const runWithPermit = request?.runWithOriginPermit;
    if (!runWithPermit) throw new Error('source cycle omitted the physical-request permit');
    const started = await runWithPermit(
      { kind: 'class', signal: new AbortController().signal },
      () => {
        onStart();
        return {
          started: Promise.resolve({
            kind: 'result' as const,
            result: {
              classKey,
              status: 'closed' as const,
              openSeats: 0,
              waitlistOpen: false,
              fetchedAt: NOW_ISO,
            },
            cache: cacheAt(NOW_ISO),
          }),
        };
      },
    );
    return started.started;
  });
  return { beginCycle, endCycle, fetch };
}

async function runCycle(
  db: Db,
  source: AvailabilitySource,
  sourceSafetyStop: SourceSafetyStopStore,
  schedule = new SourceScheduleState(),
  timing: {
    nowMs: () => number;
    sleep: (milliseconds: number) => Promise<void>;
  } = {
    nowMs: () => NOW_MS,
    sleep: async () => undefined,
  },
) {
  return runSourcePollCycle({
    repo: makeWorkerRepo(db),
    source,
    sourceSafetyStop,
    mailDispatcher: unusedMailDispatcher(),
    schedule,
    maintenance: createMaintenanceState(),
    config: workerConfig(),
    logger: logger(),
    nowMs: timing.nowMs,
    random: () => 0,
    sleep: timing.sleep,
  });
}

function makeWorkerRepo(db: Db) {
  return createWorkerRepo(db);
}

describe('v0.4.3 durable source-safety stop', () => {
  it.each([
    {
      kind: 'robots-disallow' as const,
      status: 0,
      detail: 'robots.txt: path matches Disallow: /content/',
      reason: 'robots_disallow' as SourceSafetyStopReason,
    },
    {
      kind: 'source-forbidden' as const,
      status: 403,
      detail: 'class page returned 403',
      reason: 'source_forbidden' as SourceSafetyStopReason,
    },
    {
      kind: 'source-rate-limited' as const,
      status: 429,
      detail: 'class page returned 429',
      reason: 'source_rate_limited' as SourceSafetyStopReason,
    },
  ])(
    'maps $kind to durable $reason and aborts the remaining Sections',
    async ({ kind, status, detail, reason }) => {
      const db = await dbWithTwoConfirmedSections();
      const store = createFileSourceSafetyStopStore({
        path: safetyStopPath(),
        now: () => new Date(NOW_MS),
      });
      const source = sourceThrowing(() => new FetchError(status, detail, null, kind));

      const summary = await runCycle(db, source, store);

      expect(source.fetch).toHaveBeenCalledTimes(1);
      expect(source.beginCycle).toHaveBeenCalledOnce();
      expect(source.endCycle).toHaveBeenCalledOnce();
      expect(summary).toMatchObject({
        fetched: 0,
        sourceRequests: 1,
        sourceFailures: 1,
        sourceDeferred: 1,
        sourceDisabled: true,
        healthy: false,
      });
      await expect(store.inspect()).resolves.toEqual({
        stopped: true,
        classification: reason,
      });
    },
  );

  it('survives worker/store re-instantiation and requires the exact confirmed reset', async () => {
    const db = await dbWithTwoConfirmedSections();
    const markerPath = safetyStopPath();
    const firstStore = createFileSourceSafetyStopStore({
      path: markerPath,
      now: () => new Date(NOW_MS),
    });
    const deniedSource = sourceThrowing(
      () => new FetchError(403, 'class page returned 403', null, 'source-forbidden'),
    );

    const trigger = await runCycle(db, deniedSource, firstStore);
    expect(trigger.sourceDisabled).toBe(true);

    const reinstantiatedStore = createFileSourceSafetyStopStore({ path: markerPath });
    await expect(reinstantiatedStore.inspect()).resolves.toEqual({
      stopped: true,
      classification: 'source_forbidden',
    });

    const blockedSource = successfulSource();
    const blocked = await runCycle(db, blockedSource, reinstantiatedStore);
    expect(blocked).toMatchObject({
      fetched: 0,
      sourceRequests: 0,
      sourceDeferred: 2,
      sourceDisabled: true,
      healthy: false,
    });
    expect(blockedSource.beginCycle).not.toHaveBeenCalled();
    expect(blockedSource.fetch).not.toHaveBeenCalled();

    await expect(
      resetSourceSafetyStop('RESET_WITHOUT_OPERATOR_CONFIRMATION', reinstantiatedStore),
    ).rejects.toThrow('confirmation rejected');
    await expect(reinstantiatedStore.inspect()).resolves.toEqual({
      stopped: true,
      classification: 'source_forbidden',
    });

    await resetSourceSafetyStop(SOURCE_SAFETY_STOP_RESET_CONFIRMATION, reinstantiatedStore);
    const postResetStore = createFileSourceSafetyStopStore({ path: markerPath });
    await expect(postResetStore.inspect()).resolves.toEqual({ stopped: false });

    let clockMs = NOW_MS;
    const physicalStartTimes: number[] = [];
    const resumedSource = successfulSource(() => physicalStartTimes.push(clockMs));
    const resumed = await runCycle(db, resumedSource, postResetStore, new SourceScheduleState(), {
      nowMs: () => clockMs,
      sleep: async (milliseconds) => {
        clockMs += milliseconds;
      },
    });
    expect(resumed).toMatchObject({
      fetched: 2,
      sourceRequests: 2,
      sourceDisabled: false,
    });
    expect(resumedSource.fetch).toHaveBeenCalledTimes(2);
    expect(physicalStartTimes).toHaveLength(2);
    expect(physicalStartTimes[1]! - physicalStartTimes[0]!).toBeGreaterThanOrEqual(1_000);
  });

  it.each([
    {
      caseName: 'robots 5xx',
      status: 503,
    },
    {
      caseName: 'unreachable robots',
      status: 0,
    },
  ])('$caseName skips and backs off without persisting a safety stop', async ({ status }) => {
    const db = await dbWithTwoConfirmedSections();
    const markerPath = safetyStopPath();
    const store = createFileSourceSafetyStopStore({ path: markerPath });
    const fetchImpl =
      status === 0
        ? vi.fn().mockRejectedValue(new Error('robots connection unavailable'))
        : vi.fn().mockResolvedValue(new Response('', { status }));
    const source = createPublicClassPageSource({ fetchImpl });

    const summary = await runCycle(db, source, store);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      fetched: 0,
      sourceRequests: 1,
      sourceFailures: 1,
      sourceDeferred: 1,
      sourceDisabled: false,
    });
    expect(Date.parse(summary.nextSourceCheckAt ?? '')).toBeGreaterThan(NOW_MS);
    await expect(store.inspect()).resolves.toEqual({ stopped: false });
    await expect(createFileSourceSafetyStopStore({ path: markerPath }).inspect()).resolves.toEqual({
      stopped: false,
    });
  });
});
