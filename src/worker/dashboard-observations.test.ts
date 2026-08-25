import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MailDispatcher, Notifier } from '../notify';
import type { AvailabilityObservation, AvailabilitySource, SourceCacheMetadata } from '../scraper';
import type { ClassKey } from '../shared/class-key';
import type { ParseResult, SeatState } from '../shared/seat-state';
import { runPollCycle } from './poller';
import { readV04WorkerConfig, runCacheAwarePollCycle, SourceScheduleState } from './v04';
import type { RuntimeWorkerRepo, WorkerRepo } from './types';

const CLASS_KEY = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const OBSERVED_AT = '2026-07-30T20:00:00.000Z';
const PRIOR_OBSERVATIONS = {
  displayName: 'COMPSCI 189 001 - LEC 001',
  lastEnrolled: 347,
  lastCapacity: 350,
  lastWaitlisted: 100,
  lastWaitlistMax: 100,
  lastOpenReserved: null,
} as const;

let originalKillSwitch: string | undefined;

beforeEach(() => {
  originalKillSwitch = process.env['KILL_SWITCH'];
  process.env['KILL_SWITCH'] = '0';
});

afterEach(() => {
  if (originalKillSwitch === undefined) delete process.env['KILL_SWITCH'];
  else process.env['KILL_SWITCH'] = originalKillSwitch;
});

function previousState() {
  return {
    classKey: CLASS_KEY,
    lastStatus: 'closed' as const,
    lastOpenSeats: 0,
    lastWaitlistOpen: false,
    ...PRIOR_OBSERVATIONS,
    stateVersion: 4,
    sourceFreshUntil: new Date('2026-07-30T21:00:00.000Z'),
    updatedAt: new Date('2026-07-30T19:59:00.000Z'),
  };
}

function stateWithoutDashboard(): SeatState {
  return {
    classKey: CLASS_KEY,
    status: 'closed',
    openSeats: 0,
    waitlistOpen: false,
    fetchedAt: OBSERVED_AT,
  };
}

function quietLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function idleNotifier(): Notifier {
  return {
    dispatch: vi.fn(),
    alertOperator: vi.fn(async () => undefined),
  } as unknown as Notifier;
}

function idleMailDispatcher(): MailDispatcher {
  return {
    dispatch: vi.fn(),
    dispatchBatch: vi.fn(async () => []),
    outbox: [],
  } as unknown as MailDispatcher;
}

function legacyRepo(overrides: Partial<WorkerRepo> = {}): WorkerRepo {
  return {
    getDistinctWatchedClassKeys: vi.fn(async () => [CLASS_KEY]),
    getPollCycleCutoff: vi.fn(async () => OBSERVED_AT),
    getSubscribersWatching: vi.fn(async () => []),
    claimAlertDelivery: vi.fn(async () => 'claimed' as const),
    claimOpeningDeliveries: vi.fn(async () => []),
    listPendingAlertDeliveries: vi.fn(async () => []),
    markAlertDeliverySent: vi.fn(async () => true),
    retireWatchesForClass: vi.fn(async () => 1),
    getClassState: vi.fn(async () => previousState()),
    upsertClassState: vi.fn(async () => undefined),
    ...overrides,
  };
}

function v04Repo(overrides: Partial<RuntimeWorkerRepo> = {}): RuntimeWorkerRepo {
  return {
    getDistinctWatchedClassKeys: vi.fn(async () => [CLASS_KEY]),
    getPollCycleCutoff: vi.fn(async () => OBSERVED_AT),
    getClassState: vi.fn(async () => previousState()),
    upsertClassState: vi.fn(async () => undefined),
    commitOpeningAndEnqueueMail: vi.fn(async () => ({ transitioned: true, enqueued: 0 })),
    recordParserRecovery: vi.fn(async () => false),
    recordParserBroken: vi.fn(async () => ({ status: 'already-broken' })),
    retireWatchesForClass: vi.fn(async () => 1),
    // FR-28: the cycle sweeps for Blind windows unconditionally; a no-op here.
    enqueueBlindWindowDisclosures: vi.fn(async () => ({
      disclosedSections: [],
      enqueued: 0,
    })),
    ...overrides,
  } as unknown as RuntimeWorkerRepo;
}

describe('legacy worker dashboard observation persistence', () => {
  it('clears prior observations when a successful 200 omits optional markup', async () => {
    const repo = legacyRepo();

    await runPollCycle({
      repo,
      fetchClass: vi.fn(async () => stateWithoutDashboard()),
      notifier: idleNotifier(),
      logger: quietLogger(),
      now: () => OBSERVED_AT,
    });

    expect(repo.upsertClassState).toHaveBeenCalledWith({
      classKey: CLASS_KEY,
      lastStatus: 'closed',
      lastOpenSeats: 0,
      lastWaitlistOpen: false,
      displayName: null,
      lastEnrolled: null,
      lastCapacity: null,
      lastWaitlisted: null,
      lastWaitlistMax: null,
      lastOpenReserved: null,
    });
  });

  it('carries a reserved-only opening through the atomic delivery path', async () => {
    const claimOpeningDeliveries = vi.fn(async () => []);
    const repo = legacyRepo({ claimOpeningDeliveries });
    const result: SeatState = {
      classKey: CLASS_KEY,
      status: 'open',
      openSeats: 41,
      waitlistOpen: false,
      fetchedAt: OBSERVED_AT,
      displayName: 'COMPSCI 189 001 - LEC 001',
      enrolled: 347,
      capacity: 350,
      waitlisted: 100,
      waitlistMax: 100,
      openReserved: 41,
    };

    await runPollCycle({
      repo,
      fetchClass: vi.fn(async () => result),
      notifier: idleNotifier(),
      logger: quietLogger(),
      now: () => OBSERVED_AT,
    });

    expect(claimOpeningDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        classKey: CLASS_KEY,
        reason: 'seats-open',
        openSeats: 41,
        nextState: {
          lastStatus: 'open',
          lastOpenSeats: 41,
          lastWaitlistOpen: false,
          displayName: 'COMPSCI 189 001 - LEC 001',
          lastEnrolled: 347,
          lastCapacity: 350,
          lastWaitlisted: 100,
          lastWaitlistMax: 100,
          lastOpenReserved: 41,
        },
      }),
    );
  });

  it.each([
    { kind: 'parser-broke', detail: 'required field missing' },
    { kind: 'class-gone', detail: '404' },
  ] as const)('does not overwrite observations for $kind', async (result) => {
    const repo = legacyRepo();

    await runPollCycle({
      repo,
      fetchClass: vi.fn(async () => ({ ...result, classKey: CLASS_KEY }) as ParseResult),
      notifier: idleNotifier(),
      logger: quietLogger(),
      now: () => OBSERVED_AT,
    });

    expect(repo.upsertClassState).not.toHaveBeenCalled();
    expect(repo.claimOpeningDeliveries).not.toHaveBeenCalled();
  });
});

describe('v0.4 worker dashboard observation persistence', () => {
  it('clears prior observations when a successful 200 omits optional markup', async () => {
    const repo = v04Repo();
    const source: AvailabilitySource = {
      fetch: vi.fn(
        async () =>
          ({
            kind: 'result',
            result: stateWithoutDashboard(),
            cache: null,
          }) satisfies AvailabilityObservation,
      ),
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };

    await runCacheAwarePollCycle({
      repo,
      source,
      mailDispatcher: idleMailDispatcher(),
      sourceOnly: true,
      logger: quietLogger(),
      nowMs: () => Date.parse(OBSERVED_AT),
    });

    expect(repo.upsertClassState).toHaveBeenCalledWith({
      classKey: CLASS_KEY,
      lastStatus: 'closed',
      lastOpenSeats: 0,
      lastWaitlistOpen: false,
      displayName: null,
      lastEnrolled: null,
      lastCapacity: null,
      lastWaitlisted: null,
      lastWaitlistMax: null,
      lastOpenReserved: null,
      sourceFreshUntil: new Date('2026-07-30T20:02:00.000Z'),
    });
  });

  it('carries a reserved-only opening through the atomic enqueue path', async () => {
    const commitOpeningAndEnqueueMail = vi.fn(async () => ({ transitioned: true, enqueued: 1 }));
    const repo = v04Repo({ commitOpeningAndEnqueueMail });
    const result: SeatState = {
      classKey: CLASS_KEY,
      status: 'open',
      openSeats: 41,
      waitlistOpen: false,
      fetchedAt: OBSERVED_AT,
      displayName: 'COMPSCI 189 001 - LEC 001',
      enrolled: 347,
      capacity: 350,
      waitlisted: 100,
      waitlistMax: 100,
      openReserved: 41,
    };
    const source: AvailabilitySource = {
      fetch: vi.fn(
        async () =>
          ({
            kind: 'result',
            result,
            cache: null,
          }) satisfies AvailabilityObservation,
      ),
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };

    await runCacheAwarePollCycle({
      repo,
      source,
      mailDispatcher: idleMailDispatcher(),
      sourceOnly: true,
      logger: quietLogger(),
      nowMs: () => Date.parse(OBSERVED_AT),
    });

    expect(commitOpeningAndEnqueueMail).toHaveBeenCalledWith({
      classKey: CLASS_KEY,
      previousStateVersion: 4,
      openedAt: OBSERVED_AT,
      reason: 'seats-open',
      openSeats: 41,
      nextState: {
        lastStatus: 'open',
        lastOpenSeats: 41,
        lastWaitlistOpen: false,
        displayName: 'COMPSCI 189 001 - LEC 001',
        lastEnrolled: 347,
        lastCapacity: 350,
        lastWaitlisted: 100,
        lastWaitlistMax: 100,
        lastOpenReserved: 41,
        sourceFreshUntil: new Date('2026-07-30T20:02:00.000Z'),
      },
    });
  });

  it('preserves every prior observation on a trusted 304', async () => {
    const repo = v04Repo({
      getClassState: vi.fn(async () => ({
        ...previousState(),
        lastStatus: 'open' as const,
        lastOpenSeats: 41,
        lastOpenReserved: 41,
      })),
    });
    const schedule = new SourceScheduleState();
    const config = { ...readV04WorkerConfig({}), pollJitterMs: 0 };
    const previousCache: SourceCacheMetadata = {
      checkedAt: '2026-07-30T19:55:00.000Z',
      cacheControl: 'public, max-age=0',
      ageSeconds: 0,
      maxAgeSeconds: 0,
      freshForSeconds: 0,
      freshUntil: '2026-07-30T19:55:00.000Z',
      etag: '"prior"',
      lastModified: null,
    };
    schedule.recordSuccessfulObservation(CLASS_KEY, previousCache, config, () => 0);
    const refreshedCache: SourceCacheMetadata = {
      ...previousCache,
      checkedAt: OBSERVED_AT,
      freshUntil: OBSERVED_AT,
    };
    const source: AvailabilitySource = {
      fetch: vi.fn(
        async () =>
          ({
            kind: 'not-modified',
            classKey: CLASS_KEY,
            checkedAt: OBSERVED_AT,
            cache: refreshedCache,
          }) satisfies AvailabilityObservation,
      ),
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };

    await runCacheAwarePollCycle({
      repo,
      source,
      mailDispatcher: idleMailDispatcher(),
      sourceOnly: true,
      schedule,
      config,
      logger: quietLogger(),
      nowMs: () => Date.parse(OBSERVED_AT),
      random: () => 0,
    });

    expect(repo.upsertClassState).toHaveBeenCalledWith({
      classKey: CLASS_KEY,
      lastStatus: 'open',
      lastOpenSeats: 41,
      lastWaitlistOpen: false,
      ...PRIOR_OBSERVATIONS,
      lastOpenReserved: 41,
      sourceFreshUntil: new Date('2026-07-30T20:02:00.000Z'),
    });
  });

  it.each([
    { kind: 'parser-broke', detail: 'required field missing' },
    { kind: 'class-gone', detail: '404' },
  ] as const)('does not overwrite observations for $kind', async (result) => {
    const repo = v04Repo();
    const source: AvailabilitySource = {
      fetch: vi.fn(
        async () =>
          ({
            kind: 'result',
            result: { ...result, classKey: CLASS_KEY } as ParseResult,
            cache: null,
          }) satisfies AvailabilityObservation,
      ),
      beginCycle: vi.fn(),
      endCycle: vi.fn(),
    };

    await runCacheAwarePollCycle({
      repo,
      source,
      mailDispatcher: idleMailDispatcher(),
      sourceOnly: true,
      logger: quietLogger(),
      nowMs: () => Date.parse(OBSERVED_AT),
    });

    expect(repo.upsertClassState).not.toHaveBeenCalled();
    expect(repo.commitOpeningAndEnqueueMail).not.toHaveBeenCalled();
  });
});
