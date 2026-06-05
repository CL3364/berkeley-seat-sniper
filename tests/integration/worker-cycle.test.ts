/**
 * Integration tests — worker poll cycle (AC-3, AC-4, AC-5, AC-6).
 *
 * Stack:
 *   - makeTestDb() + createWorkerRepo(db) — real PGlite, fresh per describe block
 *   - makeRepo(db) — to seed subscribers via the API-compatible repo
 *   - runPollCycle(deps) — the worker's testable core (no scheduler, no ports)
 *   - fake fetchClass — returns parseClassPage(fixture, classKey) so no network
 *   - createNotifier({ transport: createNoopTransport() }) — noop outbox
 *
 * PII rule: tests must not log subscriber emails. We inject a silent logger.
 *
 * Why the "first poll is a baseline" rule matters for AC-3 / AC-4:
 *   runPollCycle does NOT notify on the first sighting of a class (it just
 *   establishes a baseline). So the fixture sequence is:
 *     poll 1 with zero-seats.html → baseline, no notification
 *     poll 2 with open-seats.html → 0→>0 transition → notify (AC-3)
 *     poll 3 with open-seats.html → already open → no notification (AC-4)
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeTestDb, makeRepo } from '../../src/db';
import { createWorkerRepo } from '../../src/worker/repo';
import { createNotifier } from '../../src/notify/index';
import { createNoopTransport } from '../../src/notify/transports/noop';
import { runPollCycle } from '../../src/worker/poller';
import { parseClassPage } from '../../src/scraper/parse';
import type { ClassKey } from '../../src/shared/class-key';
import type { ParseResult } from '../../src/shared/seat-state';
import type { PollCycleDeps, Logger } from '../../src/worker/poller';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CK = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const VALID_EMAIL = 'subscriber@berkeley.edu';

const FIXTURE_DIR = fileURLToPath(new URL('../../src/scraper/fixtures/', import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFixture(name: string): string {
  return readFileSync(FIXTURE_DIR + name, 'utf-8');
}

/** A silent logger — keeps test output clean; tests assert on outbox, not logs. */
const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Build a fake fetchClass that always returns parseClassPage(html, classKey). */
function fakeFetch(html: string): (classKey: ClassKey) => Promise<ParseResult> {
  return async (classKey) => parseClassPage(html, classKey);
}

/** Seed one subscriber watching CK into the db. Returns the subscriber id. */
async function seedSubscriber(
  repo: ReturnType<typeof makeRepo>,
  email = VALID_EMAIL,
  classKey: ClassKey = CK,
): Promise<string> {
  const result = await repo.createSubscriber(email, [classKey]);
  return result.id;
}

// ---------------------------------------------------------------------------
// AC-3: 0→>0 transition → exactly one notification per subscriber via outbox
// ---------------------------------------------------------------------------

describe('AC-3: seat transition 0→>0 notifies each subscriber exactly once', () => {
  let deps: PollCycleDeps;
  let notifier: ReturnType<typeof createNotifier>;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

    const db = await makeTestDb();
    const apiRepo = makeRepo(db);
    const workerRepo = createWorkerRepo(db);
    notifier = createNotifier({ transport: createNoopTransport() });

    // Seed one subscriber watching CK.
    await seedSubscriber(apiRepo);

    // Default fetchClass satisfies the required PollCycleDeps field; every test
    // overrides `deps.fetchClass` before calling runPollCycle.
    deps = {
      repo: workerRepo,
      notifier,
      logger: silentLogger,
      fetchClass: fakeFetch(loadFixture('zero-seats.html')),
    };
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
    vi.restoreAllMocks();
  });

  it('poll 1 (zero-seats) establishes a baseline — outbox is empty', async () => {
    deps.fetchClass = fakeFetch(loadFixture('zero-seats.html'));
    await runPollCycle(deps);
    expect(notifier.outbox).toHaveLength(0);
  });

  it('poll 2 (open-seats) after baseline → outbox has exactly 1 subscriber entry (AC-3)', async () => {
    // Baseline poll.
    deps.fetchClass = fakeFetch(loadFixture('zero-seats.html'));
    await runPollCycle(deps);

    // Transition poll.
    deps.fetchClass = fakeFetch(loadFixture('open-seats.html'));
    await runPollCycle(deps);

    const subscriberEntries = notifier.outbox.filter((e) => e.kind === 'subscriber');
    expect(subscriberEntries).toHaveLength(1);
  });

  it('the outbox entry is addressed to the subscriber (outbox models sent mail)', async () => {
    deps.fetchClass = fakeFetch(loadFixture('zero-seats.html'));
    await runPollCycle(deps);

    deps.fetchClass = fakeFetch(loadFixture('open-seats.html'));
    await runPollCycle(deps);

    const [entry] = notifier.outbox.filter((e) => e.kind === 'subscriber');
    expect(entry.to).toBe(VALID_EMAIL);
  });

  it('fan-out: two subscribers watching the same class each get exactly one notification', async () => {
    const db = await makeTestDb();
    const apiRepo = makeRepo(db);
    const workerRepo = createWorkerRepo(db);
    const localNotifier = createNotifier({ transport: createNoopTransport() });

    await seedSubscriber(apiRepo, 'a@berkeley.edu');
    await seedSubscriber(apiRepo, 'b@berkeley.edu');

    const localDeps: PollCycleDeps = {
      repo: workerRepo,
      fetchClass: fakeFetch(loadFixture('zero-seats.html')),
      notifier: localNotifier,
      logger: silentLogger,
    };

    // Baseline.
    await runPollCycle(localDeps);

    // Transition.
    localDeps.fetchClass = fakeFetch(loadFixture('open-seats.html'));
    await runPollCycle(localDeps);

    const subscriberEntries = localNotifier.outbox.filter((e) => e.kind === 'subscriber');
    // Each of the two subscribers receives exactly one notification.
    expect(subscriberEntries).toHaveLength(2);

    // The outbox entries are addressed to distinct subscribers.
    const addresses = new Set(subscriberEntries.map((e) => e.to));
    expect(addresses.size).toBe(2);
  });

  it('CycleSummary.notified equals 1 after a single-subscriber transition', async () => {
    deps.fetchClass = fakeFetch(loadFixture('zero-seats.html'));
    await runPollCycle(deps);

    deps.fetchClass = fakeFetch(loadFixture('open-seats.html'));
    const summary = await runPollCycle(deps);

    expect(summary.notified).toBe(1);
    expect(summary.fetched).toBe(1);
    expect(summary.parserBroke).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-4: Second poll with seats still >0 → no new notification (dedupe / FR-5)
// ---------------------------------------------------------------------------

describe('AC-4: second poll with seats still open → no additional notification', () => {
  let deps: PollCycleDeps;
  let notifier: ReturnType<typeof createNotifier>;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

    const db = await makeTestDb();
    const apiRepo = makeRepo(db);
    const workerRepo = createWorkerRepo(db);
    notifier = createNotifier({ transport: createNoopTransport() });

    await seedSubscriber(apiRepo);

    // Default fetchClass satisfies the required PollCycleDeps field; every test
    // overrides `deps.fetchClass` before calling runPollCycle.
    deps = {
      repo: workerRepo,
      notifier,
      logger: silentLogger,
      fetchClass: fakeFetch(loadFixture('zero-seats.html')),
    };
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('outbox stays at 1 after two consecutive open-seats polls (AC-4)', async () => {
    // Baseline.
    deps.fetchClass = fakeFetch(loadFixture('zero-seats.html'));
    await runPollCycle(deps);

    // First opening poll — notifies.
    deps.fetchClass = fakeFetch(loadFixture('open-seats.html'));
    await runPollCycle(deps);
    expect(notifier.outbox.filter((e) => e.kind === 'subscriber')).toHaveLength(1);

    // Second poll — seats still open, no new notification.
    await runPollCycle(deps);
    expect(notifier.outbox.filter((e) => e.kind === 'subscriber')).toHaveLength(1);
  });

  it('CycleSummary.notified is 0 on the third (still-open) poll', async () => {
    deps.fetchClass = fakeFetch(loadFixture('zero-seats.html'));
    await runPollCycle(deps);

    deps.fetchClass = fakeFetch(loadFixture('open-seats.html'));
    await runPollCycle(deps);

    const thirdSummary = await runPollCycle(deps);
    expect(thirdSummary.notified).toBe(0);
    expect(thirdSummary.suppressed).toBe(0); // not even reaching the notifier
  });

  it('a seat that closes and re-opens fires a second notification (FR-5 flap)', async () => {
    // Baseline with zero seats.
    deps.fetchClass = fakeFetch(loadFixture('zero-seats.html'));
    await runPollCycle(deps);

    // Opening → 1 notification.
    deps.fetchClass = fakeFetch(loadFixture('open-seats.html'));
    await runPollCycle(deps);
    expect(notifier.outbox.filter((e) => e.kind === 'subscriber')).toHaveLength(1);

    // Seat closes again.
    deps.fetchClass = fakeFetch(loadFixture('zero-seats.html'));
    await runPollCycle(deps);
    expect(notifier.outbox.filter((e) => e.kind === 'subscriber')).toHaveLength(1);

    // Seat reopens → a second notification is legitimate (new openedAt → new key).
    deps.fetchClass = fakeFetch(loadFixture('open-seats.html'));
    // Advance now() so openedAt differs from the first opening.
    deps.now = () => new Date(Date.now() + 60_000).toISOString();
    await runPollCycle(deps);
    expect(notifier.outbox.filter((e) => e.kind === 'subscriber')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC-5: changed-shape fixture → parser-broke operator alert + zero subscriber
//        notifications + class_state NOT overwritten
// ---------------------------------------------------------------------------

describe('AC-5: parser-broke → operator alert, zero subscriber notifications, state unchanged', () => {
  let deps: PollCycleDeps;
  let notifier: ReturnType<typeof createNotifier>;
  let workerRepo: ReturnType<typeof createWorkerRepo>;

  beforeEach(async () => {
    process.env.TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

    const db = await makeTestDb();
    const apiRepo = makeRepo(db);
    workerRepo = createWorkerRepo(db);
    notifier = createNotifier({ transport: createNoopTransport() });

    await seedSubscriber(apiRepo);

    // Default fetchClass satisfies the required PollCycleDeps field; every test
    // overrides `deps.fetchClass` before calling runPollCycle.
    deps = {
      repo: workerRepo,
      notifier,
      logger: silentLogger,
      fetchClass: fakeFetch(loadFixture('zero-seats.html')),
    };
  });

  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('parser-broke produces exactly one operator-kind outbox entry and zero subscriber entries (AC-5)', async () => {
    // Establish baseline first.
    deps.fetchClass = fakeFetch(loadFixture('zero-seats.html'));
    await runPollCycle(deps);

    // Feed the broken fixture.
    deps.fetchClass = fakeFetch(loadFixture('changed-shape.html'));
    await runPollCycle(deps);

    const operatorEntries = notifier.outbox.filter((e) => e.kind === 'operator');
    const subscriberEntries = notifier.outbox.filter((e) => e.kind === 'subscriber');

    expect(operatorEntries).toHaveLength(1);
    expect(subscriberEntries).toHaveLength(0);
  });

  it('CycleSummary.parserBroke contains the class key; notified is 0 (AC-5)', async () => {
    deps.fetchClass = fakeFetch(loadFixture('zero-seats.html'));
    await runPollCycle(deps);

    deps.fetchClass = fakeFetch(loadFixture('changed-shape.html'));
    const summary = await runPollCycle(deps);

    expect(summary.parserBroke).toContain(CK);
    expect(summary.notified).toBe(0);
  });

  it('class_state is NOT overwritten by a parser-broke cycle (FR-6 / AC-5)', async () => {
    // Establish a known baseline (closed, 0 seats).
    deps.fetchClass = fakeFetch(loadFixture('zero-seats.html'));
    await runPollCycle(deps);

    const stateBefore = await workerRepo.getClassState(CK);
    expect(stateBefore).toBeDefined();
    expect(stateBefore?.lastOpenSeats).toBe(0);
    expect(stateBefore?.lastStatus).toBe('closed');

    // Parser-broke cycle — must NOT overwrite class_state.
    deps.fetchClass = fakeFetch(loadFixture('changed-shape.html'));
    await runPollCycle(deps);

    const stateAfter = await workerRepo.getClassState(CK);
    expect(stateAfter?.lastOpenSeats).toBe(0);
    expect(stateAfter?.lastStatus).toBe('closed');
    // updatedAt must not have changed.
    expect(stateAfter?.updatedAt.getTime()).toBe(stateBefore?.updatedAt.getTime());
  });

  it('after a parser-broke cycle, a subsequent good poll can still detect an opening', async () => {
    // Baseline.
    deps.fetchClass = fakeFetch(loadFixture('zero-seats.html'));
    await runPollCycle(deps);

    // Parser broke.
    deps.fetchClass = fakeFetch(loadFixture('changed-shape.html'));
    await runPollCycle(deps);

    // Recovery: seats open.
    deps.fetchClass = fakeFetch(loadFixture('open-seats.html'));
    await runPollCycle(deps);

    const subscriberEntries = notifier.outbox.filter((e) => e.kind === 'subscriber');
    expect(subscriberEntries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-6: KILL_SWITCH=1 → poll cycle performs no outbound fetch
// ---------------------------------------------------------------------------

describe('AC-6: KILL_SWITCH=1 → runPollCycle fetches nothing and returns zero summary', () => {
  afterEach(() => {
    delete process.env.KILL_SWITCH;
    delete process.env.TOKEN_SECRET;
    vi.restoreAllMocks();
  });

  it('runPollCycle returns fetched=0 when KILL_SWITCH=1 (AC-6)', async () => {
    process.env.KILL_SWITCH = '1';
    process.env.TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

    const db = await makeTestDb();
    const workerRepo = createWorkerRepo(db);
    const notifier = createNotifier({ transport: createNoopTransport() });

    const fetchSpy = vi.fn();
    const summary = await runPollCycle({
      repo: workerRepo,
      fetchClass: fetchSpy,
      notifier,
      logger: silentLogger,
    });

    expect(summary.fetched).toBe(0);
    expect(summary.notified).toBe(0);
    expect(summary.parserBroke).toHaveLength(0);
  });

  it('fetchClass is NEVER called when KILL_SWITCH=1 (AC-6 core assertion)', async () => {
    process.env.KILL_SWITCH = '1';
    process.env.TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

    const db = await makeTestDb();
    const apiRepo = makeRepo(db);
    const workerRepo = createWorkerRepo(db);
    const notifier = createNotifier({ transport: createNoopTransport() });

    // Even with a subscriber watching CK, the fetch must not happen.
    await seedSubscriber(apiRepo);

    const fetchSpy = vi.fn();
    await runPollCycle({
      repo: workerRepo,
      fetchClass: fetchSpy,
      notifier,
      logger: silentLogger,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the noop outbox stays empty when KILL_SWITCH=1', async () => {
    process.env.KILL_SWITCH = '1';
    process.env.TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

    const db = await makeTestDb();
    const apiRepo = makeRepo(db);
    const workerRepo = createWorkerRepo(db);
    const notifier = createNotifier({ transport: createNoopTransport() });

    await seedSubscriber(apiRepo);

    await runPollCycle({
      repo: workerRepo,
      fetchClass: vi.fn(),
      notifier,
      logger: silentLogger,
    });

    expect(notifier.outbox).toHaveLength(0);
  });

  it('runPollCycle without KILL_SWITCH does call fetchClass (guard against false-green)', async () => {
    delete process.env.KILL_SWITCH;
    process.env.TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

    const db = await makeTestDb();
    const apiRepo = makeRepo(db);
    const workerRepo = createWorkerRepo(db);
    const notifier = createNotifier({ transport: createNoopTransport() });

    await seedSubscriber(apiRepo);

    const fetchSpy = vi.fn().mockResolvedValue(parseClassPage(loadFixture('zero-seats.html'), CK));

    await runPollCycle({
      repo: workerRepo,
      fetchClass: fetchSpy,
      notifier,
      logger: silentLogger,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(CK);
  });
});

// ---------------------------------------------------------------------------
// AC-8: worker cycle logs no subscriber email or full watch list
// ---------------------------------------------------------------------------

describe('AC-8: worker cycle logs contain no subscriber email', () => {
  afterEach(() => {
    delete process.env.TOKEN_SECRET;
    vi.restoreAllMocks();
  });

  it('a full 0→>0 transition cycle emits no log line with the subscriber email', async () => {
    process.env.TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

    const db = await makeTestDb();
    const apiRepo = makeRepo(db);
    const workerRepo = createWorkerRepo(db);
    const notifier = createNotifier({ transport: createNoopTransport() });

    await seedSubscriber(apiRepo, VALID_EMAIL);

    // Capture all log output via the real default logger path — inject a spy logger.
    const loggedLines: string[] = [];
    const spyLogger: Logger = {
      info: (obj) => loggedLines.push(JSON.stringify(obj)),
      warn: (obj) => loggedLines.push(JSON.stringify(obj)),
      error: (obj) => loggedLines.push(JSON.stringify(obj)),
    };

    const deps: PollCycleDeps = {
      repo: workerRepo,
      fetchClass: fakeFetch(loadFixture('zero-seats.html')),
      notifier,
      logger: spyLogger,
    };

    await runPollCycle(deps);
    deps.fetchClass = fakeFetch(loadFixture('open-seats.html'));
    await runPollCycle(deps);

    for (const line of loggedLines) {
      expect(line, `log line contains subscriber email: ${line}`).not.toContain(VALID_EMAIL);
      expect(line, `log line contains email domain: ${line}`).not.toContain('berkeley.edu');
    }
  });
});

// ---------------------------------------------------------------------------
// Miscellaneous cycle correctness
// ---------------------------------------------------------------------------

describe('runPollCycle — no watched classes → empty cycle', () => {
  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('returns a zero summary when no classes are being watched', async () => {
    process.env.TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

    const db = await makeTestDb();
    const workerRepo = createWorkerRepo(db);
    const notifier = createNotifier({ transport: createNoopTransport() });
    const fetchSpy = vi.fn();

    const summary = await runPollCycle({
      repo: workerRepo,
      fetchClass: fetchSpy,
      notifier,
      logger: silentLogger,
    });

    expect(summary.fetched).toBe(0);
    expect(summary.notified).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('each unique class is fetched exactly once regardless of subscriber count (FR-3)', async () => {
    process.env.TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

    const db = await makeTestDb();
    const apiRepo = makeRepo(db);
    const workerRepo = createWorkerRepo(db);
    const notifier = createNotifier({ transport: createNoopTransport() });

    // Three subscribers all watching the SAME class.
    await seedSubscriber(apiRepo, 'a@berkeley.edu');
    await seedSubscriber(apiRepo, 'b@berkeley.edu');
    await seedSubscriber(apiRepo, 'c@berkeley.edu');

    const fetchSpy = vi.fn().mockResolvedValue(parseClassPage(loadFixture('zero-seats.html'), CK));

    await runPollCycle({
      repo: workerRepo,
      fetchClass: fetchSpy,
      notifier,
      logger: silentLogger,
    });

    // Only one HTTP fetch for one unique class, regardless of subscriber count (FR-3).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
