import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  classState,
  claimMailJobs,
  completeMailJob,
  confirmSubscriber,
  deleteSubscriber,
  isSuppressed,
  mailOutbox,
  makeRepo,
  makeTestDb,
  suppressEmail,
  watches,
} from '../../src/db';
import type { Db } from '../../src/db';
import { createMailDispatcher, createNotifier } from '../../src/notify';
import type {
  Notifier,
  ProviderOutcome,
  PushDeps,
  Transport,
  TransportMessage,
} from '../../src/notify/types';
import { FetchError } from '../../src/scraper';
import type { AvailabilitySource } from '../../src/scraper';
import type { ClassKey } from '../../src/shared/class-key';
import type { ParseResult } from '../../src/shared/seat-state';
import { createOperatorAlertDebouncer } from '../../src/worker/operator-debounce';
import { runPollCycle } from '../../src/worker/poller';
import { createWorkerRepo } from '../../src/worker/repo';
import type { WorkerRepo } from '../../src/worker/types';
import {
  createMaintenanceState,
  readV04WorkerConfig,
  runCacheAwarePollCycle,
  SourceScheduleState,
} from '../../src/worker/v04';

const CK = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const CK_SLOW = '2026-fall-compsci-61a-001-lec-001' as ClassKey;
const TOKEN_SECRET = 'worker-durability-test-secret-at-least-32-characters';

let originalKillSwitch: string | undefined;

const silent = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const disabledPush: PushDeps = {
  listPushSubscriptions: async () => [],
  deletePushSubscriptionIfMatches: async () => undefined,
  transport: {
    enabled: false,
    send: async () => ({ ok: false, gone: false }),
  },
};

function state(openSeats: number): ParseResult {
  return {
    classKey: CK,
    status: openSeats > 0 ? 'open' : 'closed',
    openSeats,
    waitlistOpen: false,
    fetchedAt: '2026-07-21T00:00:00.000Z',
  };
}

async function seedConfirmed(db: Db): Promise<void> {
  const api = makeRepo(db);
  const created = await api.createSubscriber('durable@berkeley.edu', [CK]);
  await confirmSubscriber(db, created.id);
}

function notifierFor(db: Db, transport: Transport) {
  return createNotifier({
    transport,
    isSuppressed: (email) => isSuppressed(db, email),
    push: disabledPush,
  });
}

async function markCurrentMailSent(db: Db): Promise<void> {
  for (;;) {
    const jobs = await claimMailJobs(db);
    if (jobs.length === 0) return;
    for (const job of jobs) {
      expect(
        await completeMailJob(db, {
          id: job.id,
          claimToken: job.claimToken,
          providerAcceptedAt: new Date(),
        }),
      ).toBe(true);
    }
  }
}

function sourceFor(fetch: AvailabilitySource['fetch']): AvailabilitySource {
  return {
    fetch,
    beginCycle: vi.fn(),
    endCycle: vi.fn(),
  };
}

function observation(classKey: ClassKey, openSeats: number, fetchedAt: string) {
  return {
    kind: 'result' as const,
    result: {
      classKey,
      status: openSeats > 0 ? ('open' as const) : ('closed' as const),
      openSeats,
      waitlistOpen: false,
      fetchedAt,
    },
    cache: null,
  };
}

function durableCycleHarness(db: Db, transport: Transport) {
  const repo = createWorkerRepo(db);
  const mailDispatcher = createMailDispatcher({
    transport,
    isSuppressed: (email) => isSuppressed(db, email),
    push: null,
  });
  const schedule = new SourceScheduleState();
  const maintenance = createMaintenanceState();
  const config = {
    ...readV04WorkerConfig({}),
    pollJitterMs: 0,
    sourceRequestsPerSecond: 1,
  };

  return {
    repo,
    mailDispatcher,
    run(source: AvailabilitySource, nowMs = Date.now()) {
      return runCacheAwarePollCycle({
        repo,
        source,
        mailDispatcher,
        schedule,
        maintenance,
        config,
        logger: silent,
        nowMs: () => nowMs,
        random: () => 0,
        sleep: async () => undefined,
      });
    },
  };
}

beforeEach(() => {
  originalKillSwitch = process.env.KILL_SWITCH;
  process.env.TOKEN_SECRET = TOKEN_SECRET;
  process.env.KILL_SWITCH = '0';
  delete process.env.NOOP_OUTBOX_FILE;
  silent.info.mockClear();
  silent.warn.mockClear();
  silent.error.mockClear();
});

afterEach(() => {
  if (originalKillSwitch === undefined) delete process.env.KILL_SWITCH;
  else process.env.KILL_SWITCH = originalKillSwitch;
  delete process.env.TOKEN_SECRET;
  delete process.env.POLL_INTERVAL_SECONDS;
  delete process.env.SEND_TIMEOUT_MS;
  vi.restoreAllMocks();
});

describe('durable opening delivery', () => {
  it('treats confirmation as watch activation and requires a post-confirmation baseline', async () => {
    const db = await makeTestDb();
    const api = makeRepo(db);
    const anchor = await api.createSubscriber('anchor@berkeley.edu', [CK]);
    await confirmSubscriber(db, anchor.id);
    const pending = await api.createSubscriber('newly-confirmed@berkeley.edu', [CK]);
    const repo = createWorkerRepo(db);
    const sent: TransportMessage[] = [];
    const notifier = notifierFor(db, {
      kind: 'noop',
      async send(message) {
        sent.push(message);
      },
    });
    const deps = {
      repo,
      fetchClass: async () => state(0),
      notifier,
      logger: silent,
    };

    await db.update(watches).set({ activatedAt: new Date('2020-01-01T00:00:00.000Z') });
    await runPollCycle(deps);
    await db
      .update(classState)
      .set({ updatedAt: sql`now() - interval '1 second'` })
      .where(eq(classState.classKey, CK));
    await confirmSubscriber(db, pending.id);

    deps.fetchClass = async () => state(2);
    const opened = await runPollCycle(deps);

    expect(opened.notified).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('anchor@berkeley.edu');
  });

  it('persists a failed send, advances class state, and retries the exact opening next cycle', async () => {
    const db = await makeTestDb();
    await seedConfirmed(db);
    await markCurrentMailSent(db);
    const baseMs = Date.now();
    const sent: TransportMessage[] = [];
    let attempts = 0;
    const transport: Transport = {
      kind: 'noop',
      async send(message): Promise<ProviderOutcome> {
        sent.push(message);
        attempts += 1;
        if (attempts === 1) {
          return { status: 'retryable', errorCode: 'provider_unavailable' };
        }
        return { status: 'success', acceptedAt: new Date(baseMs + 31_000) };
      },
    };
    const harness = durableCycleHarness(db, transport);

    await harness.run(
      sourceFor(async (classKey) => observation(classKey, 0, new Date(baseMs).toISOString())),
      baseMs,
    );
    const failed = await harness.run(
      sourceFor(async (classKey) =>
        observation(classKey, 3, new Date(baseMs + 30_000).toISOString()),
      ),
      baseMs + 30_000,
    );

    expect(failed.notified).toBe(0);
    expect(failed.mailDeferred).toBe(1);
    expect((await harness.repo.getClassState(CK))?.lastOpenSeats).toBe(3);
    const deferred = (await db.select().from(mailOutbox)).find((job) => job.kind === 'alert');
    expect(deferred).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastErrorCode: 'provider_unavailable',
    });
    if (!deferred) throw new Error('expected one deferred alert job');
    await db
      .update(mailOutbox)
      .set({ availableAt: sql`clock_timestamp()` })
      .where(eq(mailOutbox.id, deferred.id));

    const retried = await harness.run(
      sourceFor(async (classKey) =>
        observation(classKey, 3, new Date(baseMs + 31_000).toISOString()),
      ),
      baseMs + 31_000,
    );
    expect(retried.notified).toBe(1);
    expect(retried.mailSent).toBe(1);
    expect(
      (await db.select().from(mailOutbox)).find((job) => job.id === deferred.id),
    ).toMatchObject({
      status: 'sent',
      attempts: 2,
    });
    expect(harness.mailDispatcher.outbox.filter((entry) => entry.kind === 'alert')).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(sent[0].idempotencyKey).toBe(sent[1].idempotencyKey);
  });

  it('defers a provider 429 until its Retry-After deadline', async () => {
    const db = await makeTestDb();
    await seedConfirmed(db);
    await markCurrentMailSent(db);
    const baseMs = Date.now();
    const send = vi.fn(
      async (): Promise<ProviderOutcome> => ({
        status: 'rate-limited',
        errorCode: 'provider_rate_limited',
        retryAfterMs: 2_500,
      }),
    );
    const harness = durableCycleHarness(db, { kind: 'noop', send });

    await harness.run(
      sourceFor(async (classKey) => observation(classKey, 0, new Date(baseMs).toISOString())),
      baseMs,
    );
    const summary = await harness.run(
      sourceFor(async (classKey) =>
        observation(classKey, 1, new Date(baseMs + 30_000).toISOString()),
      ),
      baseMs + 30_000,
    );

    expect(summary.mailDeferred).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    const alert = (await db.select().from(mailOutbox)).find((job) => job.kind === 'alert');
    expect(alert).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastErrorCode: 'provider_rate_limited',
    });
    expect(alert?.availableAt.getTime()).toBe(baseMs + 32_500);
  });

  it('cancels a pending opening after the watch is removed and re-added', async () => {
    const db = await makeTestDb();
    const api = makeRepo(db);
    const created = await api.createSubscriber('reactivated@berkeley.edu', [CK]);
    await confirmSubscriber(db, created.id);
    await markCurrentMailSent(db);
    const baseMs = Date.now();
    const send = vi.fn(
      async (): Promise<ProviderOutcome> => ({
        status: 'retryable',
        errorCode: 'provider_unavailable',
      }),
    );
    const harness = durableCycleHarness(db, {
      kind: 'noop',
      send,
    });

    await harness.run(
      sourceFor(async (classKey) => observation(classKey, 0, new Date(baseMs).toISOString())),
      baseMs,
    );
    await harness.run(
      sourceFor(async (classKey) =>
        observation(classKey, 1, new Date(baseMs + 30_000).toISOString()),
      ),
      baseMs + 30_000,
    );
    await api.removeWatch(created.id, CK);
    await api.addWatch(created.id, CK);

    const replay = await harness.run(
      sourceFor(async (classKey) =>
        observation(classKey, 1, new Date(baseMs + 31_000).toISOString()),
      ),
      baseMs + 31_000,
    );

    const delivery = (await db.select().from(mailOutbox)).find((job) => job.kind === 'alert');
    expect(send).toHaveBeenCalledOnce();
    expect(replay.mailSent).toBe(0);
    expect(delivery).toMatchObject({
      status: 'cancelled',
      attempts: 1,
      terminalReason: 'subscriber-ineligible',
    });
  });

  it('cancels a pending seat alert when a later parse proves the seat closed', async () => {
    const db = await makeTestDb();
    await seedConfirmed(db);
    await markCurrentMailSent(db);
    const baseMs = Date.now();
    const send = vi.fn(
      async (): Promise<ProviderOutcome> => ({
        status: 'retryable',
        errorCode: 'provider_unavailable',
      }),
    );
    const harness = durableCycleHarness(db, { kind: 'noop', send });

    await harness.run(
      sourceFor(async (classKey) => observation(classKey, 0, new Date(baseMs).toISOString())),
      baseMs,
    );
    await harness.run(
      sourceFor(async (classKey) =>
        observation(classKey, 1, new Date(baseMs + 30_000).toISOString()),
      ),
      baseMs + 30_000,
    );
    await harness.run(
      sourceFor(async (classKey) =>
        observation(classKey, 0, new Date(baseMs + 31_000).toISOString()),
      ),
      baseMs + 31_000,
    );

    const delivery = (await db.select().from(mailOutbox)).find((job) => job.kind === 'alert');
    expect(send).toHaveBeenCalledOnce();
    expect(delivery).toMatchObject({
      status: 'cancelled',
      attempts: 1,
      terminalReason: 'opening-closed',
    });
  });

  it('continues the complete class queue before surfacing one fetch failure', async () => {
    const db = await makeTestDb();
    const api = makeRepo(db);
    const classKeys = Array.from(
      { length: 8 },
      (_, index) =>
        `2026-fall-compsci-189-${String(index + 1).padStart(3, '0')}-lec-001` as ClassKey,
    );
    for (let index = 0; index < 2; index += 1) {
      const created = await api.createSubscriber(
        `queue-${index}@berkeley.edu`,
        classKeys.slice(index * 4, index * 4 + 4),
      );
      await confirmSubscriber(db, created.id);
    }
    const calls = new Set<ClassKey>();
    const failedKey = classKeys[0];

    await expect(
      runPollCycle({
        repo: createWorkerRepo(db),
        fetchClass: async (classKey) => {
          calls.add(classKey);
          if (classKey === failedKey) throw new Error('persistent upstream failure');
          return {
            classKey,
            status: 'closed',
            openSeats: 0,
            waitlistOpen: false,
            fetchedAt: '2026-07-21T00:00:00.000Z',
          };
        },
        notifier: notifierFor(db, { kind: 'noop', send: vi.fn(async () => undefined) }),
        logger: silent,
      }),
    ).rejects.toThrow('persistent upstream failure');

    expect(calls).toEqual(new Set(classKeys));
  });

  it('dispatches a healthy opening while recording an unrelated source failure', async () => {
    const db = await makeTestDb();
    const api = makeRepo(db);
    const openKey = CK;
    const failedKey = '2026-fall-compsci-61a-001-lec-001' as ClassKey;
    const created = await api.createSubscriber('mixed-cycle@berkeley.edu', [openKey, failedKey]);
    await confirmSubscriber(db, created.id);
    await markCurrentMailSent(db);
    const baseMs = Date.now();
    const send = vi.fn(
      async (): Promise<ProviderOutcome> => ({
        status: 'success',
        acceptedAt: new Date(baseMs + 30_000),
      }),
    );
    const harness = durableCycleHarness(db, { kind: 'noop', send });

    await harness.run(
      sourceFor(async (classKey) => observation(classKey, 0, new Date(baseMs).toISOString())),
      baseMs,
    );

    const summary = await harness.run(
      sourceFor(async (classKey) => {
        if (classKey === failedKey) {
          throw new FetchError(503, 'unrelated upstream failure');
        }
        return observation(classKey, 1, new Date(baseMs + 30_000).toISOString());
      }),
      baseMs + 30_000,
    );

    expect(send).toHaveBeenCalledOnce();
    expect(summary.sourceFailures).toBe(1);
    expect(summary.mailSent).toBe(1);
    expect(summary.notified).toBe(1);
    expect((await db.select().from(mailOutbox)).find((job) => job.kind === 'alert')).toMatchObject({
      status: 'sent',
      attempts: 1,
    });
  });

  it('durably enqueues an opening before a slow fetch and dispatches after the source pass', async () => {
    const db = await makeTestDb();
    const api = makeRepo(db);
    const created = await api.createSubscriber('early-dispatch@berkeley.edu', [CK, CK_SLOW]);
    await confirmSubscriber(db, created.id);
    await markCurrentMailSent(db);
    const baseMs = Date.now();
    const send = vi.fn(
      async (): Promise<ProviderOutcome> => ({
        status: 'success',
        acceptedAt: new Date(baseMs + 30_000),
      }),
    );
    const harness = durableCycleHarness(db, { kind: 'noop', send });

    await harness.run(
      sourceFor(async (classKey) => observation(classKey, 0, new Date(baseMs).toISOString())),
      baseMs,
    );

    let slowEntered!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      slowEntered = resolve;
    });
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const opening = harness.run(
      sourceFor(async (classKey) => {
        if (classKey === CK_SLOW) {
          slowEntered();
          await slowGate;
          return observation(classKey, 0, new Date(baseMs + 30_000).toISOString());
        }
        return observation(classKey, 1, new Date(baseMs + 30_000).toISOString());
      }),
      baseMs + 30_000,
    );

    await slowStarted;
    expect((await db.select().from(mailOutbox)).find((job) => job.kind === 'alert')).toMatchObject({
      status: 'queued',
      attempts: 0,
    });
    expect(send).not.toHaveBeenCalled();

    releaseSlow();
    const summary = await opening;
    expect(summary.mailSent).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect((await db.select().from(mailOutbox)).find((job) => job.kind === 'alert')).toMatchObject({
      status: 'sent',
      attempts: 1,
    });
  });

  it('gives a late-detected opening its own delivery window and first wave', async () => {
    let releaseLate!: () => void;
    const lateGate = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    let clockMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clockMs);

    const makeDeliveries = (classKey: ClassKey, openedAt: string) =>
      Array.from({ length: 8 }, (_, index) => ({
        subscriberId: `${classKey}-subscriber-${index}`,
        email: `queue-${index}@berkeley.edu`,
        classKey,
        openedAt,
        reason: 'seats-open' as const,
        openSeats: 1,
        createdAt: new Date(openedAt),
      }));
    const repo: WorkerRepo = {
      getDistinctWatchedClassKeys: async () => [CK, CK_SLOW],
      getPollCycleCutoff: async () => '2026-07-21 00:00:00+00',
      getSubscribersWatching: async () => [],
      claimAlertDelivery: async () => 'claimed',
      claimOpeningDeliveries: async (opening) => makeDeliveries(opening.classKey, opening.openedAt),
      listPendingAlertDeliveries: async () => [],
      markAlertDeliverySent: async () => true,
      retireWatchesForClass: async () => 0,
      getClassState: async (classKey) => ({
        classKey,
        lastStatus: 'closed',
        lastOpenSeats: 0,
        lastWaitlistOpen: false,
        displayName: null,
        lastEnrolled: null,
        lastCapacity: null,
        lastWaitlisted: null,
        lastWaitlistMax: null,
        stateVersion: 0,
        updatedAt: new Date('2026-07-21T00:00:00.000Z'),
      }),
      upsertClassState: async () => undefined,
    };

    let sendCount = 0;
    const dispatch = vi.fn<Notifier['dispatch']>(async (event) => {
      sendCount += 1;
      if (sendCount === 8) {
        // The first opening consumed a complete wave and the original cycle
        // deadline has expired before the second class is detected.
        clockMs = 26_000;
        releaseLate();
      }
      return {
        sent: true,
        suppressed: false,
        pushed: 0,
        idempotencyKey: `${event.subscriberId}:${event.classKey}:${event.openedAt}`,
      };
    });
    const notifier = {
      dispatch,
      sendConfirmation: async () => ({ sent: true, suppressed: false }),
      sendManageLink: async () => ({ sent: true, suppressed: false }),
      alertOperator: async () => undefined,
      outbox: [],
    } satisfies Notifier;

    const summary = await runPollCycle({
      repo,
      fetchClass: async (classKey) => {
        if (classKey === CK_SLOW) await lateGate;
        return {
          classKey,
          status: 'open',
          openSeats: 1,
          waitlistOpen: false,
          fetchedAt: '2026-07-21T00:00:30.000Z',
        };
      },
      notifier,
      logger: silent,
      now: () => '2026-07-21T00:00:30.000Z',
    });

    expect(summary.notified).toBe(16);
    expect(dispatch).toHaveBeenCalledTimes(16);
  });

  it('claims a transition by monotonic visibility order when wall clocks run backward', async () => {
    const db = await makeTestDb();
    await seedConfirmed(db);
    await markCurrentMailSent(db);
    const baseMs = Date.now();
    const send = vi.fn(
      async (): Promise<ProviderOutcome> => ({
        status: 'success',
        acceptedAt: new Date(baseMs + 30_000),
      }),
    );
    const harness = durableCycleHarness(db, { kind: 'noop', send });

    await harness.run(
      sourceFor(async (classKey) => observation(classKey, 0, new Date(baseMs).toISOString())),
      baseMs,
    );
    // Move the observation timestamp behind the watch activation timestamp.
    // Visibility must still follow the serialized sequence order established by
    // the baseline rather than these deliberately contradictory audit clocks.
    await db.execute(
      sql`update class_state set updated_at = '2026-07-21T01:00:00.123456Z'::timestamptz where class_key = ${CK}`,
    );
    await db.execute(
      sql`update watches set activated_at = '2030-01-01T00:00:00Z'::timestamptz where class_key = ${CK}`,
    );

    const summary = await harness.run(
      sourceFor(async (classKey) =>
        observation(classKey, 1, new Date(baseMs + 30_000).toISOString()),
      ),
      baseMs + 30_000,
    );

    expect(summary.notified).toBe(1);
    expect(summary.mailSent).toBe(1);
    expect((await harness.repo.getClassState(CK))?.stateVersion).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect((await db.select().from(mailOutbox)).find((job) => job.kind === 'alert')).toMatchObject({
      status: 'sent',
      attempts: 1,
    });
  });

  it('rebaselines a state older than ten intervals without manufacturing an opening', async () => {
    process.env.POLL_INTERVAL_SECONDS = '30';
    const db = await makeTestDb();
    await seedConfirmed(db);
    const repo = createWorkerRepo(db);
    const transport: Transport = { kind: 'noop', send: vi.fn(async () => undefined) };
    const notifier = notifierFor(db, transport);

    await runPollCycle({
      repo,
      fetchClass: async () => state(0),
      notifier,
      logger: silent,
      now: () => '2026-07-21T01:00:00.000Z',
    });
    await db
      .update(classState)
      .set({ updatedAt: new Date('2026-07-21T00:00:00.000Z') })
      .where(eq(classState.classKey, CK));

    const summary = await runPollCycle({
      repo,
      fetchClass: async () => state(2),
      notifier,
      logger: silent,
      now: () => '2026-07-21T01:00:00.000Z',
    });

    expect(summary.notified).toBe(0);
    expect(await repo.listPendingAlertDeliveries()).toHaveLength(0);
    expect((await repo.getClassState(CK))?.lastOpenSeats).toBe(2);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('does not inherit an opening for a watch activated after the prior closed baseline', async () => {
    const db = await makeTestDb();
    await seedConfirmed(db);
    const repo = createWorkerRepo(db);
    const transport: Transport = { kind: 'noop', send: vi.fn(async () => undefined) };
    const notifier = notifierFor(db, transport);
    const deps = { repo, fetchClass: async () => state(0), notifier, logger: silent };

    await runPollCycle(deps);
    const api = makeRepo(db);
    const late = await api.createSubscriber('late-baseline@berkeley.edu', [CK]);
    await confirmSubscriber(db, late.id);
    // A backwards audit timestamp must not make this post-baseline activation
    // inherit the opening. The activation sequence is the ordering authority.
    await db
      .update(watches)
      .set({ activatedAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(watches.subscriberId, late.id));

    deps.fetchClass = async () => state(2);
    const summary = await runPollCycle(deps);

    expect(summary.notified).toBe(1);
    expect(transport.send).toHaveBeenCalledOnce();
    expect((transport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].to).toBe(
      'durable@berkeley.edu',
    );
  });

  it('rechecks eligibility inside the send permit so queued work cannot outlive unsubscribe', async () => {
    const db = await makeTestDb();
    const api = makeRepo(db);
    const subscribers = [];
    for (let index = 0; index < 9; index += 1) {
      const record = await api.createSubscriber(`queued-${index}@berkeley.edu`, [CK]);
      await confirmSubscriber(db, record.id);
      subscribers.push({ id: record.id, email: `queued-${index}@berkeley.edu` });
    }

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let eightStarted!: () => void;
    const startedGate = new Promise<void>((resolve) => {
      eightStarted = resolve;
    });
    const started = new Set<string>();
    const transport: Transport = {
      kind: 'noop',
      async send(message) {
        started.add(message.to);
        if (started.size === 8) eightStarted();
        await gate;
      },
    };
    const repo = createWorkerRepo(db);
    const notifier = notifierFor(db, transport);
    const deps = { repo, fetchClass: async () => state(0), notifier, logger: silent };
    await runPollCycle(deps);

    deps.fetchClass = async () => state(1);
    const opening = runPollCycle(deps);
    await startedGate;
    const queued = subscribers.find((subscriber) => !started.has(subscriber.email));
    if (!queued) throw new Error('expected one subscriber to remain behind the send permit');
    await deleteSubscriber(db, queued.id);
    release();

    const summary = await opening;
    expect(summary.notified).toBe(8);
    expect(started).not.toContain(queued.email);
  });

  it('caps active recipient sends at eight while continuing the whole fan-out', async () => {
    const db = await makeTestDb();
    const api = makeRepo(db);
    for (let i = 0; i < 20; i += 1) {
      const created = await api.createSubscriber(`fanout-${i}@berkeley.edu`, [CK]);
      await confirmSubscriber(db, created.id);
    }
    const repo = createWorkerRepo(db);
    let active = 0;
    let maxActive = 0;
    const transport: Transport = {
      kind: 'noop',
      async send() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
    };
    const notifier = notifierFor(db, transport);
    const deps = { repo, fetchClass: async () => state(0), notifier, logger: silent };

    await runPollCycle(deps);
    deps.fetchClass = async () => state(1);
    const summary = await runPollCycle(deps);

    expect(summary.notified).toBe(20);
    expect(maxActive).toBe(8);
  });

  it('leaves excess durable claims pending when the cycle delivery window is exhausted', async () => {
    process.env.POLL_INTERVAL_SECONDS = '1';
    process.env.SEND_TIMEOUT_MS = '6000';
    const db = await makeTestDb();
    const api = makeRepo(db);
    for (let index = 0; index < 20; index += 1) {
      const created = await api.createSubscriber(`budget-${index}@berkeley.edu`, [CK]);
      await confirmSubscriber(db, created.id);
    }
    const repo = createWorkerRepo(db);
    const transport: Transport = {
      kind: 'noop',
      async send() {
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    };
    const notifier = notifierFor(db, transport);
    const deps = { repo, fetchClass: async () => state(0), notifier, logger: silent };

    await runPollCycle(deps);
    deps.fetchClass = async () => state(1);
    const summary = await runPollCycle(deps);

    expect(summary.notified).toBe(8);
    expect(await repo.listPendingAlertDeliveries()).toHaveLength(12);
  });

  it('counts a suppression-gated delivery as addressSuppressed and completes its ledger row', async () => {
    const db = await makeTestDb();
    await seedConfirmed(db);
    await suppressEmail(db, 'durable@berkeley.edu', 'bounce');
    const repo = createWorkerRepo(db);
    const transport: Transport = { kind: 'noop', send: vi.fn(async () => undefined) };
    const notifier = notifierFor(db, transport);
    const deps = { repo, fetchClass: async () => state(0), notifier, logger: silent };

    await runPollCycle(deps);
    deps.fetchClass = async () => state(1);
    const summary = await runPollCycle(deps);

    expect(summary.notified).toBe(0);
    expect(summary.suppressed).toBe(0);
    expect(summary.addressSuppressed).toBe(1);
    expect(await repo.listPendingAlertDeliveries()).toHaveLength(0);
    expect(transport.send).not.toHaveBeenCalled();
  });
});

describe('operator episode delivery state', () => {
  it('pages once for a transient robots outage while still throwing for scheduler backoff', async () => {
    const db = await makeTestDb();
    await seedConfirmed(db);
    const repo = createWorkerRepo(db);
    const notifier = notifierFor(db, {
      kind: 'noop',
      async send() {},
    });
    const debouncer = createOperatorAlertDebouncer();
    const deps = {
      repo,
      fetchClass: async (): Promise<ParseResult> => {
        throw new FetchError(503, 'robots.txt: server error (503) — skipping fetch this cycle');
      },
      notifier,
      debouncer,
      logger: silent,
    };

    await expect(runPollCycle(deps)).rejects.toBeInstanceOf(FetchError);
    await expect(runPollCycle(deps)).rejects.toBeInstanceOf(FetchError);

    expect(notifier.outbox.filter((entry) => entry.kind === 'operator')).toHaveLength(1);
    expect(silent.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'parser_broke', episodeKey: '__robots__' }),
    );
  });

  it('rolls back a failed operator-page reservation so the next broken cycle retries', async () => {
    const db = await makeTestDb();
    await seedConfirmed(db);
    const repo = createWorkerRepo(db);
    let attempts = 0;
    const transport: Transport = {
      kind: 'noop',
      async send(message) {
        if (message.subject.startsWith('[OPERATOR]')) {
          attempts += 1;
          if (attempts === 1) throw new Error('operator provider failure');
        }
      },
    };
    const notifier = notifierFor(db, transport);
    const debouncer = createOperatorAlertDebouncer();
    const broken = {
      kind: 'parser-broke' as const,
      classKey: CK,
      detail: 'seat selector missing',
    };
    const deps = {
      repo,
      fetchClass: async (): Promise<ParseResult> => broken,
      notifier,
      debouncer,
      logger: silent,
    };

    const first = await runPollCycle(deps);
    const second = await runPollCycle(deps);

    expect(first.operatorAlerted).toEqual([]);
    expect(second.operatorAlerted).toEqual([CK]);
    expect(attempts).toBe(2);
    expect(notifier.outbox.filter((entry) => entry.kind === 'operator')).toHaveLength(1);
  });
});
