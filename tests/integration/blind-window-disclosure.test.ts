/**
 * Blind-window disclosure (FR-28 / AC-36 / ADR 0010).
 *
 * ADR 0010 accepts a single best-effort Operator who is never woken, which
 * guarantees stretches where nothing is watched. This suite pins the rule that
 * makes that acceptable: when a watched Section goes unread for the horizon, its
 * watchers are told EXACTLY ONCE per window, and a successful read rearms it.
 *
 * The load-bearing case is RESTART. The elapsed clock and the already-told fact
 * are both durable — `class_state.updated_at` and the disclosure row's own
 * partial unique index — so every cycle here re-instantiates the worker repo and
 * all process-local state, exactly as a redeploy or a lease handoff would.
 *
 * ADDRESSES: every non-subscriber address here is @example.com. Subscriber
 * addresses cannot be — `SubscriberEmailSchema` requires an exact
 * `@berkeley.edu` domain (FR-1), so the rows use obviously synthetic
 * `blind-*@berkeley.edu` local parts, the same convention as the rest of
 * tests/integration/**. None is a real mailbox.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BLIND_WINDOW_MS,
  classState,
  confirmSubscriber,
  enqueueBlindWindowDisclosures,
  mailOutbox,
  getPollCycleCutoff,
  MAIL_ALERT_EXPIRY_MS,
  makeRepo,
  makeTestDb,
  retireWatchesForClass,
  upsertClassState,
  watches,
  type Db,
} from '../../src/db';
import {
  createFakePushTransport,
  createMailDispatcher,
  createNoopTransport,
  type MailDispatchJob,
  type MailDispatcher,
} from '../../src/notify';
import type { AvailabilitySource } from '../../src/scraper';
import type { ClassKey } from '../../src/shared/class-key';
import {
  SourceScheduleState,
  createMaintenanceState,
  createWorkerRepo,
  readV04WorkerConfig,
  runSourcePollCycle,
  type V04Logger,
  type V04WorkerConfig,
} from '../../src/worker/public';

const CLASS_KEY = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const OTHER_CLASS_KEY = '2026-fall-stat-134-001-lec-001' as ClassKey;
const MINUTE_MS = 60 * 1_000;

let originalKillSwitch: string | undefined;

beforeEach(() => {
  originalKillSwitch = process.env.KILL_SWITCH;
  process.env.KILL_SWITCH = '0';
});

afterEach(() => {
  if (originalKillSwitch === undefined) delete process.env.KILL_SWITCH;
  else process.env.KILL_SWITCH = originalKillSwitch;
  vi.restoreAllMocks();
});

function logger(): V04Logger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function workerConfig(overrides: Partial<V04WorkerConfig> = {}): V04WorkerConfig {
  return { ...readV04WorkerConfig({}), pollJitterMs: 0, sourceRequestsPerSecond: 1, ...overrides };
}

/** A source that never gets consulted — every cycle here has fetching disabled. */
function unreachableSource(): AvailabilitySource {
  return {
    beginCycle: vi.fn(),
    endCycle: vi.fn(),
    fetch: vi.fn(async () => {
      throw new Error('source fetch attempted while fetching was disabled');
    }),
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

/**
 * One poll cycle with EVERY piece of process-local worker state rebuilt: a fresh
 * repo binding, a fresh source schedule, fresh maintenance state. This is what a
 * worker restart or an advisory-lease handoff actually looks like, and it is the
 * condition under which an in-memory episode set would either double-send or
 * restart the elapsed clock.
 */
async function runRestartedCycle(
  db: Db,
  nowMs: number,
  log = logger(),
  source: AvailabilitySource = unreachableSource(),
) {
  return runSourcePollCycle({
    repo: createWorkerRepo(db),
    source,
    mailDispatcher: unusedMailDispatcher(),
    schedule: new SourceScheduleState(),
    maintenance: createMaintenanceState(),
    config: workerConfig(),
    logger: log,
    nowMs: () => nowMs,
    random: () => 0,
    sleep: async () => undefined,
  });
}

/** A source whose every fetch succeeds — the worker coming back up healthy. */
function healthySource(checkedAt: string): AvailabilitySource {
  return {
    beginCycle: vi.fn(),
    endCycle: vi.fn(),
    fetch: vi.fn(async (classKey, request) => {
      const runWithPermit = request?.runWithOriginPermit;
      if (!runWithPermit) throw new Error('source cycle omitted the physical-request permit');
      const started = await runWithPermit(
        { kind: 'class', signal: new AbortController().signal },
        () => ({
          started: Promise.resolve({
            kind: 'result' as const,
            result: {
              classKey,
              status: 'closed' as const,
              openSeats: 0,
              waitlistOpen: false,
              fetchedAt: checkedAt,
            },
            cache: null,
          }),
        }),
      );
      return started.started;
    }),
  };
}

/** Create a Confirmed Subscriber watching `classKeys`. Synthetic address only. */
async function confirmedWatcher(db: Db, email: string, classKeys: ClassKey[]): Promise<string> {
  const created = await makeRepo(db).createSubscriber(email, classKeys);
  expect(await confirmSubscriber(db, created.id)).toBe('confirmed');
  return created.id;
}

/** Record one successful read of a Section, stamping `class_state.updated_at`. */
async function recordSuccessfulRead(db: Db, classKey: ClassKey): Promise<Date> {
  await upsertClassState(db, {
    classKey,
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
  const [row] = await db
    .select()
    .from(classState)
    .where(eq(classState.classKey, classKey))
    .limit(1);
  return row!.updatedAt;
}

async function disclosures(db: Db) {
  return (await db.select().from(mailOutbox)).filter((job) => job.kind === 'blind-window');
}

/**
 * Claim the queued Blind-window job. Subscribing also queues a confirmation
 * email, so the batch always holds more than the disclosure under test.
 */
async function claimDisclosure(db: Db): Promise<MailDispatchJob> {
  const claimed = await createWorkerRepo(db).claimMailJobs({ limit: 25 });
  const job = claimed.find((candidate) => candidate.kind === 'blind-window');
  expect(job).toBeDefined();
  return job!;
}

describe('FR-28 blind-window detection', () => {
  it('stays silent until the horizon, then discloses exactly once', async () => {
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-horizon@berkeley.edu', [CLASS_KEY]);
    const lastRead = await recordSuccessfulRead(db, CLASS_KEY);

    const justInside = await enqueueBlindWindowDisclosures(db, {
      now: new Date(lastRead.getTime() + BLIND_WINDOW_MS - MINUTE_MS),
    });
    expect(justInside).toEqual({ disclosedSections: [], enqueued: 0 });
    expect(await disclosures(db)).toHaveLength(0);

    const past = await enqueueBlindWindowDisclosures(db, {
      now: new Date(lastRead.getTime() + BLIND_WINDOW_MS + MINUTE_MS),
    });
    expect(past).toEqual({ disclosedSections: [CLASS_KEY], enqueued: 1 });

    const [job] = await disclosures(db);
    expect(job).toMatchObject({
      kind: 'blind-window',
      classKey: CLASS_KEY,
      status: 'queued',
      // A Blind window is not an Opening: no reason, and no one-hour expiry.
      reason: null,
      expiresAt: null,
    });
    // `opened_at` is the window START — the last successful read.
    expect(job!.openedAt?.toISOString()).toBe(lastRead.toISOString());
    // Nothing but counts and identifiers is retained on the row.
    expect(job!.payload).toEqual({});
  });

  it('reuses the one-hour actionability horizon rather than inventing a threshold', () => {
    // ADR 0010: "The 60-minute boundary is not a new constant." The DERIVATION
    // is the invariant, not the number — pinning only the literal would let the
    // two drift apart while still passing, and the product would then tell two
    // different stories about when seat information stops being worth acting on.
    expect(BLIND_WINDOW_MS).toBe(MAIL_ALERT_EXPIRY_MS);
    expect(BLIND_WINDOW_MS).toBe(60 * 60 * 1_000);
  });

  it('never repeats for the same window, across cycles AND a worker restart', async () => {
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-restart@berkeley.edu', [CLASS_KEY]);
    const lastRead = await recordSuccessfulRead(db, CLASS_KEY);
    const past = lastRead.getTime() + BLIND_WINDOW_MS + MINUTE_MS;

    // The kill switch is the point: it blinds every Section while writing no
    // per-Section failure record anywhere, so nothing else could detect it.
    process.env.KILL_SWITCH = '1';

    const first = await runRestartedCycle(db, past);
    expect(first.blindWindowDisclosed).toBe(1);
    expect(first.blindSections).toEqual([CLASS_KEY]);

    // Every subsequent cycle rebuilds all worker state from scratch and jumps
    // hours forward. An in-memory episode set would re-alert on each of these.
    const second = await runRestartedCycle(db, past + 60 * MINUTE_MS);
    const third = await runRestartedCycle(db, past + 600 * MINUTE_MS);
    expect(second.blindWindowDisclosed).toBe(0);
    expect(third.blindWindowDisclosed).toBe(0);
    expect(second.blindSections).toEqual([]);

    expect(await disclosures(db)).toHaveLength(1);
  });

  it('discloses the gap left by worker DOWNTIME, on the very cycle that recovers', async () => {
    // The commonest Blind window of all: a redeploy, a crash, an OOM kill, a
    // lost lease. Nothing is running, so nothing records a failure — and the
    // first cycle back reads every Section as due and stamps class_state to
    // now. A sweep placed AFTER the source phase would therefore see a
    // perfectly fresh Section and disclose nothing, silently erasing the exact
    // outage this feature exists to report. Sweeping first sees the real gap.
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-downtime@berkeley.edu', [CLASS_KEY]);
    const lastRead = await recordSuccessfulRead(db, CLASS_KEY);

    // Three hours later the worker comes back, and the source is healthy again.
    const backUpAt = lastRead.getTime() + 3 * 60 * MINUTE_MS;
    const recovered = healthySource(new Date(backUpAt).toISOString());
    const summary = await runRestartedCycle(db, backUpAt, logger(), recovered);

    expect(recovered.fetch).toHaveBeenCalled();
    expect(summary.blindWindowDisclosed).toBe(1);
    expect(summary.blindSections).toEqual([CLASS_KEY]);
    // The disclosure names the window that actually elapsed, not the recovery.
    expect((await disclosures(db))[0]!.openedAt?.toISOString()).toBe(lastRead.toISOString());

    // That same cycle's successful read rearms: a later window discloses again,
    // and the recovery itself does not produce a second email for the old one.
    const secondRead = await recordSuccessfulRead(db, CLASS_KEY);
    expect(
      await enqueueBlindWindowDisclosures(db, { now: new Date(secondRead.getTime() + MINUTE_MS) }),
    ).toEqual({ disclosedSections: [], enqueued: 0 });
    expect(await disclosures(db)).toHaveLength(1);
  });

  it('stays silent while the origin still vouches for the answer we hold', async () => {
    // The source scheduler declines to re-request a Section while its
    // Cache-Control is still fresh, and honours a max-age of up to a year. By
    // elapsed time alone a correctly-cached healthy Section is indistinguishable
    // from an outage — and telling watchers we had stopped watching one would be
    // a FALSE disclosure, worse than the silence this feature breaks.
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-cached@berkeley.edu', [CLASS_KEY]);
    const lastRead = await recordSuccessfulRead(db, CLASS_KEY);
    const wellPastTheHorizon = new Date(lastRead.getTime() + 5 * 60 * MINUTE_MS);

    // The origin said this representation is good for six hours.
    await db
      .update(classState)
      .set({
        sourceFreshUntil: sql`${new Date(lastRead.getTime() + 6 * 60 * MINUTE_MS).toISOString()}::timestamptz`,
      })
      .where(eq(classState.classKey, CLASS_KEY));

    expect(await enqueueBlindWindowDisclosures(db, { now: wellPastTheHorizon })).toEqual({
      disclosedSections: [],
      enqueued: 0,
    });

    // Once that guarantee lapses and we still have not read it, we ARE blind.
    const afterTheCacheLapses = new Date(lastRead.getTime() + 7 * 60 * MINUTE_MS);
    expect(await enqueueBlindWindowDisclosures(db, { now: afterTheCacheLapses })).toEqual({
      disclosedSections: [CLASS_KEY],
      enqueued: 1,
    });
    // The window is still dated from the last successful READ, not the lapse.
    expect((await disclosures(db))[0]!.openedAt?.toISOString()).toBe(lastRead.toISOString());
  });

  it('logs the disclosure with class keys and counts only', async () => {
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-log@berkeley.edu', [CLASS_KEY]);
    const lastRead = await recordSuccessfulRead(db, CLASS_KEY);
    process.env.KILL_SWITCH = '1';

    const log = logger();
    await runRestartedCycle(db, lastRead.getTime() + BLIND_WINDOW_MS + MINUTE_MS, log);

    expect(log.warn).toHaveBeenCalledWith({
      event: 'blind_window_disclosed',
      classKeys: [CLASS_KEY],
      sectionCount: 1,
      enqueued: 1,
      windowMs: BLIND_WINDOW_MS,
      classification: 'blind_window',
    });
    const logged = JSON.stringify(log.warn.mock.calls) + JSON.stringify(log.info.mock.calls);
    expect(logged).not.toContain('blind-log@berkeley.edu');
    expect(logged).not.toContain('@berkeley.edu');
  });

  it('rearms after a successful read: a later window discloses again', async () => {
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-rearm@berkeley.edu', [CLASS_KEY]);
    const firstRead = await recordSuccessfulRead(db, CLASS_KEY);

    const firstWindow = await enqueueBlindWindowDisclosures(db, {
      now: new Date(firstRead.getTime() + BLIND_WINDOW_MS + MINUTE_MS),
    });
    expect(firstWindow.enqueued).toBe(1);

    // A recovered parse. This is the ONLY rearm mechanism: it advances the
    // window start, which is the identity the once-per-window index keys on.
    const secondRead = await recordSuccessfulRead(db, CLASS_KEY);
    expect(secondRead.getTime()).toBeGreaterThan(firstRead.getTime());

    // Still nothing while the new window is young.
    expect(
      await enqueueBlindWindowDisclosures(db, {
        now: new Date(secondRead.getTime() + MINUTE_MS),
      }),
    ).toEqual({ disclosedSections: [], enqueued: 0 });

    const secondWindow = await enqueueBlindWindowDisclosures(db, {
      now: new Date(secondRead.getTime() + BLIND_WINDOW_MS + MINUTE_MS),
    });
    expect(secondWindow).toEqual({ disclosedSections: [CLASS_KEY], enqueued: 1 });

    const jobs = await disclosures(db);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.openedAt?.toISOString()))).toEqual(
      new Set([firstRead.toISOString(), secondRead.toISOString()]),
    );
    // Two windows, two distinct provider keys — no collision on retry.
    expect(new Set(jobs.map((job) => job.providerIdempotencyKey)).size).toBe(2);
  });

  it('discloses a Section that has NEVER been read, dating the window from activation', async () => {
    // The worst case, not a benign one: a Watch added while the source is down
    // has no class_state row, so a clock keyed only on class_state would exempt
    // exactly the Subscriber who has never once been covered.
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-never-read@berkeley.edu', [CLASS_KEY]);
    expect(await db.select().from(classState)).toHaveLength(0);

    const [watch] = await db.select().from(watches).limit(1);
    const activatedAt = watch!.activatedAt!;

    expect(
      await enqueueBlindWindowDisclosures(db, {
        now: new Date(activatedAt.getTime() + BLIND_WINDOW_MS - MINUTE_MS),
      }),
    ).toEqual({ disclosedSections: [], enqueued: 0 });

    const swept = await enqueueBlindWindowDisclosures(db, {
      now: new Date(activatedAt.getTime() + BLIND_WINDOW_MS + MINUTE_MS),
    });
    expect(swept).toEqual({ disclosedSections: [CLASS_KEY], enqueued: 1 });
    expect((await disclosures(db))[0]!.openedAt?.toISOString()).toBe(activatedAt.toISOString());
  });

  it('gives a brand-new Watch its own grace period on a long-unpolled Section', async () => {
    // `class_state` outlives the Watches that created it: removing the last
    // Watch on a Section stops it being polled but leaves the row behind for 90
    // days. Dating the window from that stale row would tell someone "we are
    // not watching this, last read three weeks ago" seconds after they signed
    // up, for a class the worker reads fine two minutes later. A Subscriber is
    // owed disclosure only for the time THEY were relying on us.
    const db = await makeTestDb();
    const staleRead = await recordSuccessfulRead(db, CLASS_KEY);
    // Three weeks pass with nobody watching, then someone subscribes.
    await confirmedWatcher(db, 'blind-newcomer@berkeley.edu', [CLASS_KEY]);
    const [watch] = await db.select().from(watches).limit(1);
    const activatedAt = watch!.activatedAt!;
    expect(activatedAt.getTime()).toBeGreaterThanOrEqual(staleRead.getTime());

    // Moments after signing up — and well past the horizon measured from the
    // stale row — they hear nothing.
    expect(
      await enqueueBlindWindowDisclosures(db, {
        now: new Date(activatedAt.getTime() + MINUTE_MS),
      }),
    ).toEqual({ disclosedSections: [], enqueued: 0 });

    // An hour of their OWN unwatched time still earns a disclosure, dated from
    // when they started watching rather than from the stale read.
    const swept = await enqueueBlindWindowDisclosures(db, {
      now: new Date(activatedAt.getTime() + BLIND_WINDOW_MS + MINUTE_MS),
    });
    expect(swept).toEqual({ disclosedSections: [CLASS_KEY], enqueued: 1 });
    expect((await disclosures(db))[0]!.openedAt?.toISOString()).toBe(activatedAt.toISOString());
  });

  it('tells every watcher of a blind Section, once each', async () => {
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-fanout-a@berkeley.edu', [CLASS_KEY]);
    await confirmedWatcher(db, 'blind-fanout-b@berkeley.edu', [CLASS_KEY]);
    const lastRead = await recordSuccessfulRead(db, CLASS_KEY);
    const past = new Date(lastRead.getTime() + BLIND_WINDOW_MS + MINUTE_MS);

    expect(await enqueueBlindWindowDisclosures(db, { now: past })).toEqual({
      disclosedSections: [CLASS_KEY],
      enqueued: 2,
    });
    // The Section is reported once; the fan-out count is separate.
    expect(await enqueueBlindWindowDisclosures(db, { now: past })).toEqual({
      disclosedSections: [],
      enqueued: 0,
    });
    expect(await disclosures(db)).toHaveLength(2);
  });

  it('leaves a Section alone while it is still being read', async () => {
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-mixed@berkeley.edu', [CLASS_KEY, OTHER_CLASS_KEY]);
    const blindSince = await recordSuccessfulRead(db, CLASS_KEY);
    const now = new Date(blindSince.getTime() + BLIND_WINDOW_MS + MINUTE_MS);
    // The healthy Section was read a moment ago, well inside the horizon. The
    // sweep runs at a simulated `now`, so its last read is dated to match.
    await recordSuccessfulRead(db, OTHER_CLASS_KEY);
    await db
      .update(classState)
      .set({ updatedAt: sql`${now.toISOString()}::timestamptz` })
      .where(eq(classState.classKey, OTHER_CLASS_KEY));

    const swept = await enqueueBlindWindowDisclosures(db, { now });

    expect(swept.disclosedSections).toEqual([CLASS_KEY]);
    expect((await disclosures(db)).map((job) => job.classKey)).toEqual([CLASS_KEY]);
  });
});

describe('FR-28 eligibility mirrors the Alert fan-out', () => {
  it('never discloses to a Pending Subscriber (FR-9)', async () => {
    const db = await makeTestDb();
    // Created but deliberately NOT confirmed.
    await makeRepo(db).createSubscriber('blind-pending@berkeley.edu', [CLASS_KEY]);
    const lastRead = await recordSuccessfulRead(db, CLASS_KEY);

    const swept = await enqueueBlindWindowDisclosures(db, {
      now: new Date(lastRead.getTime() + BLIND_WINDOW_MS + MINUTE_MS),
    });

    expect(swept).toEqual({ disclosedSections: [], enqueued: 0 });
  });

  it('never discloses on a retired Watch (FR-13)', async () => {
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-retired@berkeley.edu', [CLASS_KEY]);
    const lastRead = await recordSuccessfulRead(db, CLASS_KEY);
    expect(await retireWatchesForClass(db, CLASS_KEY, await getPollCycleCutoff(db))).toBe(1);

    const swept = await enqueueBlindWindowDisclosures(db, {
      now: new Date(lastRead.getTime() + BLIND_WINDOW_MS + MINUTE_MS),
    });

    expect(swept).toEqual({ disclosedSections: [], enqueued: 0 });
  });

  it('cancels a queued disclosure when the Section turns out to be gone (FR-13)', async () => {
    // class-gone retires the Watch and deliberately tells the Subscriber
    // nothing. A disclosure already in the queue must not sneak past that and
    // announce we stopped watching a class that no longer exists.
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-class-gone@berkeley.edu', [CLASS_KEY]);
    const lastRead = await recordSuccessfulRead(db, CLASS_KEY);
    expect(
      (
        await enqueueBlindWindowDisclosures(db, {
          now: new Date(lastRead.getTime() + BLIND_WINDOW_MS + MINUTE_MS),
        })
      ).enqueued,
    ).toBe(1);

    await retireWatchesForClass(db, CLASS_KEY, await getPollCycleCutoff(db));

    const [job] = await disclosures(db);
    expect(job).toMatchObject({ status: 'cancelled', terminalReason: 'subscriber-ineligible' });
  });
});

describe('FR-28 disclosure delivery', () => {
  it('sends the disclosure copy, suppression-gated and with unsubscribe headers', async () => {
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-delivery@berkeley.edu', [CLASS_KEY]);
    const lastRead = await recordSuccessfulRead(db, CLASS_KEY);
    await enqueueBlindWindowDisclosures(db, {
      now: new Date(lastRead.getTime() + BLIND_WINDOW_MS + MINUTE_MS),
    });

    const dispatcher = createMailDispatcher({
      transport: createNoopTransport(),
      appBaseUrl: 'https://seatsniper.example.com',
      from: 'alerts@seatsniper.example.com',
      operatorEmail: 'operator@example.com',
      isSuppressed: async () => false,
      mintToken: () => 'stable-test-token',
      push: null,
    });

    const result = await dispatcher.dispatch(await claimDisclosure(db));
    expect(result.status).toBe('success');

    const entry = dispatcher.outbox.find((row) => row.kind === 'blind-window');
    expect(entry!.subject).toBe(`Seat Sniper is not watching ${CLASS_KEY} right now`);
    expect(entry!.body).toContain('Silence about this class is not currently evidence');
    expect(entry!.body).toContain(`Last successful read: ${lastRead.toISOString()} (UTC)`);
    expect(entry!.body).toContain('run by one person');
    expect(entry!.body).toContain('classes.berkeley.edu/content/');
  });

  it('withholds a disclosure to a suppressed address (FR-12)', async () => {
    // Unlike an Operator alert, this is subscriber-facing bulk mail and is not
    // exempt from deliverability hygiene.
    const db = await makeTestDb();
    await confirmedWatcher(db, 'blind-suppressed@berkeley.edu', [CLASS_KEY]);
    const lastRead = await recordSuccessfulRead(db, CLASS_KEY);
    await enqueueBlindWindowDisclosures(db, {
      now: new Date(lastRead.getTime() + BLIND_WINDOW_MS + MINUTE_MS),
    });

    const dispatcher = createMailDispatcher({
      transport: createNoopTransport(),
      appBaseUrl: 'https://seatsniper.example.com',
      from: 'alerts@seatsniper.example.com',
      operatorEmail: 'operator@example.com',
      isSuppressed: async () => true,
      mintToken: () => 'stable-test-token',
      push: null,
    });

    const result = await dispatcher.dispatch(await claimDisclosure(db));

    expect(result.status).toBe('suppressed');
    expect(dispatcher.outbox).toHaveLength(0);
  });

  it('does not push — the push contract is alerts-only', async () => {
    const db = await makeTestDb();
    const subscriberId = await confirmedWatcher(db, 'blind-nopush@berkeley.edu', [CLASS_KEY]);
    const lastRead = await recordSuccessfulRead(db, CLASS_KEY);
    await enqueueBlindWindowDisclosures(db, {
      now: new Date(lastRead.getTime() + BLIND_WINDOW_MS + MINUTE_MS),
    });

    const listPushSubscriptions = vi.fn(async () => [
      {
        endpoint: 'https://push.example.com/endpoint',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      },
    ]);
    const pushTransport = createFakePushTransport();
    const dispatcher = createMailDispatcher({
      transport: createNoopTransport(),
      appBaseUrl: 'https://seatsniper.example.com',
      from: 'alerts@seatsniper.example.com',
      operatorEmail: 'operator@example.com',
      isSuppressed: async () => false,
      mintToken: () => 'stable-test-token',
      push: {
        listPushSubscriptions,
        deletePushSubscriptionIfMatches: vi.fn(async () => undefined),
        transport: pushTransport,
      },
    });

    await dispatcher.dispatch(await claimDisclosure(db));

    // Push is pinned to Openings by `PushAlertPayloadSchema`. A Blind window
    // must never reach a browser notification saying a seat is available.
    expect(listPushSubscriptions).not.toHaveBeenCalled();
    expect(pushTransport.sent).toHaveLength(0);
    expect(subscriberId).toBeTruthy();
  });
});

describe('FR-28 durable shape is enforced by the database', () => {
  it('refuses a disclosure row that cannot say when the class was last read', async () => {
    const db = await makeTestDb();
    const subscriberId = await confirmedWatcher(db, 'blind-shape@berkeley.edu', [CLASS_KEY]);

    await expect(
      db.insert(mailOutbox).values({
        id: 'blind-window-no-opened-at',
        kind: 'blind-window',
        subscriberId,
        classKey: CLASS_KEY,
        openedAt: null,
        providerIdempotencyKey: 'seat-sniper/blind-window/shape-invalid',
        payload: {},
      }),
    ).rejects.toThrow();
  });

  it('refuses a second disclosure for the same window even on a direct insert', async () => {
    // The guarantee is the partial unique index, not the sweep's own bookkeeping
    // — that is what makes it hold across concurrent workers.
    const db = await makeTestDb();
    const subscriberId = await confirmedWatcher(db, 'blind-unique@berkeley.edu', [CLASS_KEY]);
    const windowStartedAt = new Date('2026-08-25T06:00:00.000Z');

    const row = {
      kind: 'blind-window' as const,
      subscriberId,
      classKey: CLASS_KEY,
      openedAt: windowStartedAt,
      payload: {},
    };
    await db
      .insert(mailOutbox)
      .values({ ...row, id: 'blind-window-1', providerIdempotencyKey: 'key-1' });

    await expect(
      db
        .insert(mailOutbox)
        .values({ ...row, id: 'blind-window-2', providerIdempotencyKey: 'key-2' }),
    ).rejects.toThrow();
  });

  it('leaves an Alert for the same Section and moment untouched', async () => {
    // The two indexes are independent: an Opening and a Blind window can share
    // a (subscriber, class, timestamp) triple without colliding.
    const db = await makeTestDb();
    const subscriberId = await confirmedWatcher(db, 'blind-coexist@berkeley.edu', [CLASS_KEY]);
    const at = new Date('2026-08-25T06:00:00.000Z');

    await db.insert(mailOutbox).values({
      id: 'coexist-blind',
      kind: 'blind-window',
      subscriberId,
      classKey: CLASS_KEY,
      openedAt: at,
      providerIdempotencyKey: 'coexist-blind-key',
      payload: {},
    });
    await db.insert(mailOutbox).values({
      id: 'coexist-alert',
      kind: 'alert',
      subscriberId,
      classKey: CLASS_KEY,
      openedAt: at,
      reason: 'seats-open',
      expiresAt: new Date(at.getTime() + 60 * 60 * 1_000),
      providerIdempotencyKey: 'coexist-alert-key',
      payload: { openSeats: 1, openReserved: null },
    });

    const rows = await db
      .select()
      .from(mailOutbox)
      .where(and(eq(mailOutbox.subscriberId, subscriberId), eq(mailOutbox.classKey, CLASS_KEY)));

    expect(rows.map((row) => row.kind).sort()).toEqual(['alert', 'blind-window']);
  });
});
