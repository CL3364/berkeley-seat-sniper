/**
 * Integration tests — worker poll cycle (AC-3, AC-4, AC-5, AC-6, AC-7 notify side).
 *
 * Uses the public barrel imports as specified:
 *   src/worker/public  — runPollCycle, createWorkerRepo, types
 *   src/notify         — createNotifier, createNoopTransport
 *   src/scraper        — parseClassPage
 *
 * Pattern per test:
 *   db   = await makeTestDb()          (fresh PGlite, isolated)
 *   repo = createWorkerRepo(db)         (worker fan-out repo)
 *   api  = makeRepo(db)                 (subscriber seeding / unsubscribe)
 *   notifier = createNotifier({ transport: createNoopTransport() })
 *   fetchClass = (k) => Promise.resolve(parseClassPage(loadFixture(f), k))
 *
 * Baseline rule (FR-4): runPollCycle does NOT notify on the first sighting of
 * a class — it establishes a persisted baseline. Transitions are detected on
 * subsequent polls.
 *
 * PII: tests never log subscriber emails. The silent logger is injected for
 * all runPollCycle calls.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { makeTestDb, makeRepo, confirmSubscriber, isSuppressed } from '../../src/db';
import type { Db } from '../../src/db';
import { runPollCycle, createWorkerRepo } from '../../src/worker/public';
import type { PollCycleDeps, CycleSummary, WorkerRepo } from '../../src/worker/public';
import { createNotifier, createNoopTransport } from '../../src/notify';
import type { OutboxEntry } from '../../src/notify';
import { parseClassPage } from '../../src/scraper';
import type { ClassKey } from '../../src/shared/class-key';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIR = fileURLToPath(new URL('../../src/scraper/fixtures/', import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(FIXTURE_DIR + name, 'utf-8');
}

/** Rebind a saved page's canonical identity to the requested test Section. */
function withFixtureIdentity(html: string, classKey: ClassKey): string {
  return html.replace(
    /(href=["']https:\/\/classes\.berkeley\.edu\/content\/)[^"'?#\s]+/i,
    `$1${classKey}`,
  );
}

/** A fake fetchClass backed by a fixture file. Flip fixture between polls by
 *  reassigning deps.fetchClass. */
function fakeFetch(
  fixtureName: string,
): (k: ClassKey) => Promise<ReturnType<typeof parseClassPage>> {
  return (k) =>
    Promise.resolve(parseClassPage(withFixtureIdentity(loadFixture(fixtureName), k), k));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CK = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const EMAIL_A = 'alice@berkeley.edu';
const EMAIL_B = 'bob@berkeley.edu';
const TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

/** Silent logger — keeps test output clean. */
const silent = {
  info: (_o: Record<string, unknown>) => undefined,
  warn: (_o: Record<string, unknown>) => undefined,
  error: (_o: Record<string, unknown>) => undefined,
};

// ---------------------------------------------------------------------------
// Per-test helpers
// ---------------------------------------------------------------------------

interface TestBed {
  db: Db;
  repo: WorkerRepo;
  api: ReturnType<typeof makeRepo>;
  notifier: ReturnType<typeof createNotifier>;
  deps: PollCycleDeps;
  /**
   * Create a CONFIRMED subscriber watching the given classes. The worker fans
   * out only to CONFIRMED subscribers (FR-9 / AC-3 / AC-9), so a worker test
   * MUST confirm — otherwise getSubscribersWatching returns 0 and every alert
   * assertion fails with "got 0". This helper composes createSubscriber +
   * confirmSubscriber so individual tests stay focused on the cycle behavior.
   */
  createConfirmed(email: string, classKeys?: ClassKey[]): Promise<{ id: string }>;
}

async function makeTestBed(): Promise<TestBed> {
  const db = await makeTestDb();
  const repo = createWorkerRepo(db);
  const api = makeRepo(db);
  const notifier = createNotifier({
    transport: createNoopTransport(),
    isSuppressed: (email) => isSuppressed(db, email),
  });
  const deps: PollCycleDeps = {
    repo,
    fetchClass: fakeFetch('zero-seats.html'), // safe default; tests override
    notifier,
    logger: silent,
  };
  const createConfirmed = async (email: string, classKeys: ClassKey[] = [CK]) => {
    const created = await api['createSubscriber'](email, classKeys);
    await confirmSubscriber(db, created.id);
    return { id: created.id };
  };
  return { db, repo, api, notifier, deps, createConfirmed };
}

function subscriberOutbox(outbox: OutboxEntry[]): OutboxEntry[] {
  // v0.3: the seat-open subscriber alert is kind 'alert' (was 'subscriber').
  return outbox.filter((e) => e.kind === 'alert');
}

function operatorOutbox(outbox: OutboxEntry[]): OutboxEntry[] {
  return outbox.filter((e) => e.kind === 'operator');
}

let originalKillSwitch: string | undefined;

beforeEach(() => {
  originalKillSwitch = process.env.KILL_SWITCH;
  process.env.KILL_SWITCH = '0';
});

afterEach(() => {
  if (originalKillSwitch === undefined) delete process.env.KILL_SWITCH;
  else process.env.KILL_SWITCH = originalKillSwitch;
});

// ---------------------------------------------------------------------------
// AC-3: 0 → >0 transition notifies each subscriber exactly once
// ---------------------------------------------------------------------------

describe('AC-3: 0→>0 transition → exactly one notification per subscriber', () => {
  beforeEach(() => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.TOKEN_SECRET;
    vi.restoreAllMocks();
  });

  it('poll#1 (zero-seats baseline) → outbox empty; poll#2 (open-seats) → exactly 1 entry', async () => {
    const { notifier, deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);

    // Baseline — no notification.
    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);
    expect(subscriberOutbox(notifier.outbox)).toHaveLength(0);

    // Transition — notify.
    deps.fetchClass = fakeFetch('open-seats.html');
    await runPollCycle(deps);
    expect(subscriberOutbox(notifier.outbox)).toHaveLength(1);
  });

  it('the single outbox entry is addressed to the subscriber', async () => {
    const { notifier, deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);

    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);
    deps.fetchClass = fakeFetch('open-seats.html');
    await runPollCycle(deps);

    const [entry] = subscriberOutbox(notifier.outbox);
    expect(entry.to).toBe(EMAIL_A);
  });

  it('CycleSummary.notified === 1 after single-subscriber transition', async () => {
    const { deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);

    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);
    deps.fetchClass = fakeFetch('open-seats.html');
    const summary: CycleSummary = await runPollCycle(deps);

    expect(summary.notified).toBe(1);
    expect(summary.fetched).toBe(1);
    expect(summary.parserBroke).toHaveLength(0);
  });

  it('two subscribers watching the same class each get exactly one notification (fan-out, FR-3)', async () => {
    const { notifier, deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);
    await createConfirmed(EMAIL_B, [CK]);

    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);
    deps.fetchClass = fakeFetch('open-seats.html');
    const summary: CycleSummary = await runPollCycle(deps);

    const entries = subscriberOutbox(notifier.outbox);
    expect(entries).toHaveLength(2);
    // Each subscriber received one entry addressed to them.
    const addresses = new Set(entries.map((e) => e.to));
    expect(addresses).toEqual(new Set([EMAIL_A, EMAIL_B]));
    expect(summary.notified).toBe(2);
  });

  it('each unique class fetched exactly once regardless of subscriber count (FR-3)', async () => {
    const { deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);
    await createConfirmed(EMAIL_B, [CK]);

    const spy = vi.fn().mockResolvedValue(parseClassPage(loadFixture('zero-seats.html'), CK));
    deps.fetchClass = spy;
    await runPollCycle(deps);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(CK);
  });

  it('waitlist-open fixture triggers a notification with reason="waitlist-open"', async () => {
    const { notifier, deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);

    // Baseline: closed (0 seats, waitlist closed).
    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);

    // Transition: waitlist opens.
    deps.fetchClass = fakeFetch('waitlist-open.html');
    await runPollCycle(deps);

    const entries = subscriberOutbox(notifier.outbox);
    expect(entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-4: Second poll with seats still >0 → no new notification (dedupe / FR-5)
// ---------------------------------------------------------------------------

describe('AC-4: second open-seats poll → no new notification (dedupe)', () => {
  beforeEach(() => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('poll#3 (still open) → outbox unchanged; summary.notified === 0', async () => {
    const { notifier, deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);

    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps); // baseline

    deps.fetchClass = fakeFetch('open-seats.html');
    await runPollCycle(deps); // poll#2 → notifies
    expect(subscriberOutbox(notifier.outbox)).toHaveLength(1);

    const summary: CycleSummary = await runPollCycle(deps); // poll#3 → no new notify
    expect(subscriberOutbox(notifier.outbox)).toHaveLength(1);
    expect(summary.notified).toBe(0);
    expect(summary.suppressed).toBe(0); // worker-level guard fires before notifier
  });

  it('a seat that closes then reopens fires a second notification (FR-5 flap)', async () => {
    const { notifier, deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);
    let observedAt = new Date().toISOString();
    deps.now = () => observedAt;

    // Baseline.
    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);

    // Opening #1.
    deps.fetchClass = fakeFetch('open-seats.html');
    observedAt = new Date(Date.parse(observedAt) + 60_000).toISOString();
    await runPollCycle(deps);
    expect(subscriberOutbox(notifier.outbox)).toHaveLength(1);

    // Class closes.
    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);

    // Opening #2 — different openedAt → different idempotency key → re-notified.
    deps.fetchClass = fakeFetch('open-seats.html');
    observedAt = new Date(Date.parse(observedAt) + 60_000).toISOString();
    await runPollCycle(deps);
    expect(subscriberOutbox(notifier.outbox)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC-5: changed-shape fixture → parser-broke operator alert + zero subscriber
//        notifications + class_state NOT updated (FR-6)
// ---------------------------------------------------------------------------

describe('AC-5: changed-shape → parser-broke, no subscriber notify, state unchanged', () => {
  beforeEach(() => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('parser-broke cycle → 1 operator entry, 0 subscriber entries, summary.parserBroke has the key', async () => {
    const { notifier, deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);

    // Baseline.
    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);

    // Broken page.
    deps.fetchClass = fakeFetch('changed-shape.html');
    const summary: CycleSummary = await runPollCycle(deps);

    expect(operatorOutbox(notifier.outbox)).toHaveLength(1);
    expect(subscriberOutbox(notifier.outbox)).toHaveLength(0);
    expect(summary.parserBroke).toContain(CK);
    expect(summary.notified).toBe(0);
  });

  it('class_state is NOT overwritten when the parser breaks (FR-6 / AC-5)', async () => {
    const { repo, deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);

    // Establish a known baseline.
    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);
    const before = await repo.getClassState(CK);
    expect(before).toBeDefined();
    expect(before!.lastOpenSeats).toBe(0);
    expect(before!.lastStatus).toBe('closed');

    // Parser-broke cycle must not touch class_state.
    deps.fetchClass = fakeFetch('changed-shape.html');
    await runPollCycle(deps);
    const after = await repo.getClassState(CK);

    expect(after!.lastOpenSeats).toBe(0);
    expect(after!.lastStatus).toBe('closed');
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it('recovery after parser-broke: next good poll still detects the opening', async () => {
    const { notifier, deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);

    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps); // baseline

    deps.fetchClass = fakeFetch('changed-shape.html');
    await runPollCycle(deps); // broke

    deps.fetchClass = fakeFetch('open-seats.html');
    await runPollCycle(deps); // recovery → should notify

    expect(subscriberOutbox(notifier.outbox)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-6: KILL_SWITCH=1 → no outbound fetch, zero summary, zero outbox
// ---------------------------------------------------------------------------

describe('AC-6: KILL_SWITCH=1 → fetchClass never called, fetched=0', () => {
  beforeEach(() => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.KILL_SWITCH;
    delete process.env.TOKEN_SECRET;
    vi.restoreAllMocks();
  });

  it('fetchClass is never invoked when KILL_SWITCH=1', async () => {
    process.env.KILL_SWITCH = '1';
    const { deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);

    const spy = vi.fn();
    deps.fetchClass = spy;
    await runPollCycle(deps);

    expect(spy).not.toHaveBeenCalled();
  });

  it('summary has fetched=0, notified=0, parserBroke=[] when KILL_SWITCH=1', async () => {
    process.env.KILL_SWITCH = '1';
    const { deps } = await makeTestBed();

    const summary: CycleSummary = await runPollCycle({ ...deps, fetchClass: vi.fn() });

    expect(summary.fetched).toBe(0);
    expect(summary.notified).toBe(0);
    expect(summary.parserBroke).toHaveLength(0);
  });

  it('outbox stays empty when KILL_SWITCH=1', async () => {
    process.env.KILL_SWITCH = '1';
    const { notifier, deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);

    await runPollCycle({ ...deps, fetchClass: vi.fn() });

    expect(notifier.outbox).toHaveLength(0);
  });

  it('with exact KILL_SWITCH=0, fetchClass is called (guard against false-green)', async () => {
    process.env.KILL_SWITCH = '0';
    const { deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);

    const spy = vi.fn().mockResolvedValue(parseClassPage(loadFixture('zero-seats.html'), CK));
    deps.fetchClass = spy;
    await runPollCycle(deps);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(CK);
  });
});

// ---------------------------------------------------------------------------
// AC-7 (notify side): unsubscribe → subsequent opening sends nothing to them
// ---------------------------------------------------------------------------

describe('AC-7 notify side: unsubscribed subscriber receives no notification on opening', () => {
  beforeEach(() => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('after unsubscribe, an opening produces zero subscriber outbox entries for that user', async () => {
    const { api, notifier, deps, createConfirmed } = await makeTestBed();
    const { id } = await createConfirmed(EMAIL_A, [CK]);

    // Establish baseline while subscriber is active.
    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);

    // Unsubscribe — removes subscriber row and their watches (cascade).
    await api.deleteSubscriber(id);

    // Opening poll — nobody is watching, so no fan-out.
    deps.fetchClass = fakeFetch('open-seats.html');
    await runPollCycle(deps);

    expect(subscriberOutbox(notifier.outbox)).toHaveLength(0);
  });

  it('unsubscribed user gets nothing even when another subscriber still watches (selective fan-out)', async () => {
    const { api, notifier, deps, createConfirmed } = await makeTestBed();
    const { id: idA } = await createConfirmed(EMAIL_A, [CK]);
    await createConfirmed(EMAIL_B, [CK]);

    // Baseline.
    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);

    // Unsubscribe alice only.
    await api.deleteSubscriber(idA);

    // Opening — only bob should be notified.
    deps.fetchClass = fakeFetch('open-seats.html');
    await runPollCycle(deps);

    const entries = subscriberOutbox(notifier.outbox);
    expect(entries).toHaveLength(1);
    expect(entries[0].to).toBe(EMAIL_B);
  });

  it('summary.notified is 0 when the only subscriber unsubscribed before the opening', async () => {
    const { api, deps, createConfirmed } = await makeTestBed();
    const { id } = await createConfirmed(EMAIL_A, [CK]);

    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);

    await api.deleteSubscriber(id);

    deps.fetchClass = fakeFetch('open-seats.html');
    const summary: CycleSummary = await runPollCycle(deps);

    expect(summary.notified).toBe(0);
    expect(summary.fetched).toBe(0); // no watches left → nothing in the queue
  });
});

// ---------------------------------------------------------------------------
// AC-8 (worker): no subscriber email in any log line during a poll cycle
// ---------------------------------------------------------------------------

describe('AC-8: worker cycle logs contain no subscriber email', () => {
  beforeEach(() => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.TOKEN_SECRET;
    vi.restoreAllMocks();
  });

  it('a complete 0→>0 cycle emits no log containing the subscriber email', async () => {
    const { deps, createConfirmed } = await makeTestBed();
    await createConfirmed(EMAIL_A, [CK]);

    const lines: string[] = [];
    const spyLogger = {
      info: (o: Record<string, unknown>) => lines.push(JSON.stringify(o)),
      warn: (o: Record<string, unknown>) => lines.push(JSON.stringify(o)),
      error: (o: Record<string, unknown>) => lines.push(JSON.stringify(o)),
    };

    deps.logger = spyLogger;
    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);
    deps.fetchClass = fakeFetch('open-seats.html');
    await runPollCycle(deps);

    for (const line of lines) {
      expect(line, `log line contains subscriber email: ${line}`).not.toContain(EMAIL_A);
      expect(line, `log line contains email domain: ${line}`).not.toContain('berkeley.edu');
    }
  });
});
