/**
 * Integration tests — worker v0.3 behaviors (AC-9, AC-14, AC-15, D13).
 *
 * Drives runPollCycle against fixture-backed ParseResults with a real PGlite db
 * and a noop-transport notifier (FR-8 outbox). Covers:
 *   - AC-9  : a Pending subscriber receives NO alert; only the Confirmed one does.
 *   - AC-14 : class-gone retires every watch, no operator/subscriber alert,
 *             class_state untouched, next cycle does not fetch it.
 *   - AC-15 : operator-alert debounce (one per episode) + recovery reset +
 *             robots-level episode collapse onto one key.
 *   - D13   : a simultaneous seat+waitlist opening alerts ONCE (seats-open wins).
 *
 * PII: a silent logger (or a capturing spy) is injected; emails never logged.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  makeTestDb,
  makeRepo,
  confirmSubscriber,
  getPollCycleCutoff,
  isSuppressed,
  retireWatchesForClass,
  watches,
} from '../../src/db';
import type { Db } from '../../src/db';
import { runPollCycle, createWorkerRepo } from '../../src/worker/public';
import type { PollCycleDeps, WorkerRepo } from '../../src/worker/public';
import {
  createOperatorAlertDebouncer,
  ROBOTS_EPISODE_KEY,
} from '../../src/worker/operator-debounce';
import { createNotifier, createNoopTransport } from '../../src/notify';
import type { Notifier, OutboxEntry } from '../../src/notify';
import { parseClassPage } from '../../src/scraper';
import type { ClassKey } from '../../src/shared/class-key';
import type { ParseResult } from '../../src/shared/seat-state';

// ---------------------------------------------------------------------------
// Fixtures + constants
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

const CK = '2026-fall-compsci-189-001-lec-001' as ClassKey;
const CK2 = '2026-fall-compsci-61a-001-lec-001' as ClassKey;
const EMAIL_PENDING = 'pending@berkeley.edu';
const EMAIL_CONFIRMED = 'confirmed@berkeley.edu';
const TOKEN_SECRET = 'test-secret-for-integration-tests-minimum-32-chars';

const silent = {
  info: (_o: Record<string, unknown>) => undefined,
  warn: (_o: Record<string, unknown>) => undefined,
  error: (_o: Record<string, unknown>) => undefined,
};

function fakeFetch(fixtureName: string): (k: ClassKey) => Promise<ParseResult> {
  return (k) =>
    Promise.resolve(parseClassPage(withFixtureIdentity(loadFixture(fixtureName), k), k));
}

/** A fetchClass that returns a fixed ParseResult for every class. */
function constResult(result: ParseResult): (k: ClassKey) => Promise<ParseResult> {
  return () => Promise.resolve(result);
}

function alertOutbox(outbox: OutboxEntry[]): OutboxEntry[] {
  return outbox.filter((e) => e.kind === 'alert');
}
function operatorOutbox(outbox: OutboxEntry[]): OutboxEntry[] {
  return outbox.filter((e) => e.kind === 'operator');
}

interface Bed {
  db: Db;
  repo: WorkerRepo;
  api: ReturnType<typeof makeRepo>;
  notifier: Notifier;
  deps: PollCycleDeps;
}

async function makeBed(): Promise<Bed> {
  const db = await makeTestDb();
  const repo = createWorkerRepo(db);
  const api = makeRepo(db);
  const notifier = createNotifier({
    transport: createNoopTransport(),
    isSuppressed: (email) => isSuppressed(db, email),
  });
  const deps: PollCycleDeps = {
    repo,
    fetchClass: fakeFetch('zero-seats.html'),
    notifier,
    logger: silent,
  };
  return { db, repo, api, notifier, deps };
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
// AC-9: a Pending subscriber receives NO alert (FR-9)
// ---------------------------------------------------------------------------

describe('AC-9: pending subscriber receives no alert; only the confirmed one is alerted', () => {
  beforeEach(() => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.TOKEN_SECRET;
    vi.restoreAllMocks();
  });

  it('AC-9: two subscribers (one Pending, one Confirmed) on the same class → exactly one alert, to the Confirmed one', async () => {
    const { db, api, notifier, deps } = await makeBed();
    // Pending: created but NOT confirmed.
    await api.createSubscriber(EMAIL_PENDING, [CK]);
    // Confirmed: created then confirmed.
    const { id: confirmedId } = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, confirmedId);

    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps); // baseline
    deps.fetchClass = fakeFetch('open-seats.html');
    const summary = await runPollCycle(deps); // transition

    const alerts = alertOutbox(notifier.outbox);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].to).toBe(EMAIL_CONFIRMED);
    expect(summary.notified).toBe(1);
  });

  it('AC-9: the Pending subscriber address appears in NO alert outbox entry', async () => {
    const { db, api, notifier, deps } = await makeBed();
    await api.createSubscriber(EMAIL_PENDING, [CK]);
    const { id } = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, id);

    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);
    deps.fetchClass = fakeFetch('open-seats.html');
    await runPollCycle(deps);

    const toPending = notifier.outbox.filter((e) => e.to === EMAIL_PENDING);
    expect(toPending).toHaveLength(0);
  });

  it('AC-9: a lone Pending subscriber drives neither scraping nor alerts', async () => {
    const { api, notifier, deps } = await makeBed();
    await api.createSubscriber(EMAIL_PENDING, [CK]); // never confirmed

    const fetchClass = vi.fn(fakeFetch('open-seats.html'));
    deps.fetchClass = fetchClass;
    const summary = await runPollCycle(deps);

    expect(fetchClass).not.toHaveBeenCalled();
    expect(summary.fetched).toBe(0);
    expect(alertOutbox(notifier.outbox)).toHaveLength(0);
    expect(summary.notified).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-14: class-gone retires watches, no operator/subscriber alert, state intact
// ---------------------------------------------------------------------------

describe('AC-14: class-gone retires every watch; no operator page; no subscriber alert; state unchanged', () => {
  beforeEach(() => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  const classGone: ParseResult = { kind: 'class-gone', classKey: CK, detail: '404 for test' };

  it('AC-14: a class-gone cycle retires the watch (manage view no longer lists it)', async () => {
    const { db, api, repo, deps } = await makeBed();
    const { id } = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, id);

    // Baseline establishes the watch as live + class_state seeded.
    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);

    // class-gone cycle.
    deps.fetchClass = constResult(classGone);
    const summary = await runPollCycle(deps);

    // The watch is retired → it disappears from the manage view and the queue.
    const managed = await api.getSubscriberById(id);
    expect(managed?.watches).not.toContain(CK);
    expect(summary.classGone).toContain(CK);

    // The next cycle does NOT fetch the retired class (queue is now empty).
    const spy = vi.fn();
    await runPollCycle({ ...deps, repo, fetchClass: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  it('AC-14: a class-gone cycle pages NO operator and alerts NO subscriber', async () => {
    const { db, api, notifier, deps } = await makeBed();
    const { id } = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, id);

    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);

    deps.fetchClass = constResult(classGone);
    await runPollCycle(deps);

    expect(operatorOutbox(notifier.outbox)).toHaveLength(0);
    expect(alertOutbox(notifier.outbox)).toHaveLength(0);
  });

  it('AC-14: class_state is NOT overwritten by a class-gone cycle', async () => {
    const { db, api, repo, deps } = await makeBed();
    const { id } = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, id);

    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);
    const before = await repo.getClassState(CK);
    expect(before).toBeDefined();

    deps.fetchClass = constResult(classGone);
    await runPollCycle(deps);
    const after = await repo.getClassState(CK);

    expect(after?.lastOpenSeats).toBe(before!.lastOpenSeats);
    expect(after?.lastStatus).toBe(before!.lastStatus);
    expect(after?.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it('AC-14: the class-not-found.html fixture (200 soft-404) is detected as class-gone', async () => {
    const { db, api, notifier, deps } = await makeBed();
    const { id } = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, id);

    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);

    // The parser maps the soft-404 page to a class-gone arm (isNotFoundPage is in
    // the fetch layer; here we exercise parse → not-found copy via the worker by
    // returning a class-gone result keyed to the fixture's intent).
    const { isNotFoundPage } = await import('../../src/scraper');
    expect(isNotFoundPage(loadFixture('class-not-found.html'))).toBe(true);

    deps.fetchClass = constResult({
      kind: 'class-gone',
      classKey: CK,
      detail: 'not-found page (200)',
    });
    const summary = await runPollCycle(deps);

    expect(summary.classGone).toContain(CK);
    expect(operatorOutbox(notifier.outbox)).toHaveLength(0);
    expect(alertOutbox(notifier.outbox)).toHaveLength(0);
  });

  it('does not retire a watch activated while the class-gone fetch is in flight', async () => {
    const { db, api, deps } = await makeBed();
    const original = await api.createSubscriber('original-gone@berkeley.edu', [CK]);
    await confirmSubscriber(db, original.id);
    await db
      .update(watches)
      .set({ activatedAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(watches.subscriberId, original.id));

    let enterFetch!: () => void;
    const fetchEntered = new Promise<void>((resolve) => {
      enterFetch = resolve;
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    deps.fetchClass = async () => {
      enterFetch();
      await fetchGate;
      return classGone;
    };

    const cycle = runPollCycle(deps);
    await fetchEntered;
    const late = await api.createSubscriber('late-gone@berkeley.edu', [CK]);
    await confirmSubscriber(db, late.id);
    // Deliberately move the audit timestamp behind the cycle cutoff. Retirement
    // must use the monotonic activation order, not wall-clock comparison.
    await db
      .update(watches)
      .set({ activatedAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(watches.subscriberId, late.id));
    releaseFetch();
    await cycle;

    expect((await api.getSubscriberById(original.id))?.watches).not.toContain(CK);
    expect((await api.getSubscriberById(late.id))?.watches).toContain(CK);
  });

  it('retires a Pending watch too and does not revive historical retirement on confirm', async () => {
    const { db, api, deps } = await makeBed();
    const anchor = await api.createSubscriber('confirmed-gone-anchor@berkeley.edu', [CK]);
    await confirmSubscriber(db, anchor.id);
    const pending = await api.createSubscriber('pending-during-gone@berkeley.edu', [CK]);

    deps.fetchClass = constResult(classGone);
    const summary = await runPollCycle(deps);
    expect(summary.classGone).toContain(CK);
    expect((await api.getSubscriberById(anchor.id))?.watches).not.toContain(CK);
    expect((await api.getSubscriberById(pending.id))?.watches).toEqual([]);

    await confirmSubscriber(db, pending.id);
    expect((await api.getSubscriberById(pending.id))?.watches).toEqual([]);
  });

  it('orders a pre-cutoff activation commit before the exact retirement boundary', async () => {
    const { db, api } = await makeBed();
    const owner = await api.createSubscriber('cutoff-order@berkeley.edu', [CK2]);
    await confirmSubscriber(db, owner.id);

    let inserted!: () => void;
    const insertReached = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    let releaseInsert!: () => void;
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    const activation = db.transaction(async (tx) => {
      await tx.execute(sql.raw('LOCK TABLE "watches" IN ROW EXCLUSIVE MODE'));
      await tx.insert(watches).values({
        subscriberId: owner.id,
        classKey: CK,
        // Equal/backward timestamps cannot move this causally earlier than the
        // visibility generation allocated by the insert.
        activatedAt: new Date('2020-01-01T00:00:00.000Z'),
      });
      inserted();
      await insertGate;
    });

    await insertReached;
    const cutoffPromise = getPollCycleCutoff(db);
    const capturedEarly = await Promise.race([
      cutoffPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(capturedEarly).toBe(false);

    releaseInsert();
    await activation;
    const cutoff = await cutoffPromise;
    expect(await retireWatchesForClass(db, CK, cutoff)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-15: operator-alert debounce + recovery + robots collapse
// ---------------------------------------------------------------------------

describe('AC-15: operator-alert debounce, recovery reset, robots collapse', () => {
  beforeEach(() => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  const broke: ParseResult = {
    kind: 'parser-broke',
    classKey: CK,
    detail: 'seat-count node not found',
  };

  it('AC-15a: a class broken across 3 consecutive cycles produces exactly ONE operator entry', async () => {
    const { db, api, notifier, deps } = await makeBed();
    const { id } = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, id);

    // Shared debouncer so episode state survives across cycles (FR-14 / AC-15).
    const debouncer = createOperatorAlertDebouncer();
    const d = { ...deps, debouncer };

    d.fetchClass = constResult(broke);
    await runPollCycle(d);
    await runPollCycle(d);
    await runPollCycle(d);

    expect(operatorOutbox(notifier.outbox)).toHaveLength(1);
  });

  it('AC-15a: after a clean-parse recovery, the next break produces exactly one more operator entry', async () => {
    const { db, api, notifier, deps } = await makeBed();
    const { id } = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, id);

    const debouncer = createOperatorAlertDebouncer();
    const d = { ...deps, debouncer };

    // Episode 1: break (alert once), break again (debounced).
    d.fetchClass = constResult(broke);
    await runPollCycle(d);
    await runPollCycle(d);
    expect(operatorOutbox(notifier.outbox)).toHaveLength(1);

    // Recovery: a clean parse closes the episode (logged).
    d.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(d);

    // Episode 2: a fresh break alerts again → total now 2.
    d.fetchClass = constResult(broke);
    await runPollCycle(d);
    expect(operatorOutbox(notifier.outbox)).toHaveLength(2);
  });

  it('AC-15a: a recovery is logged (operator_episode_recovered)', async () => {
    const { db, api, deps } = await makeBed();
    const { id } = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, id);

    const lines: Record<string, unknown>[] = [];
    const spyLogger = {
      info: (o: Record<string, unknown>) => lines.push(o),
      warn: (o: Record<string, unknown>) => lines.push(o),
      error: (o: Record<string, unknown>) => lines.push(o),
    };
    const debouncer = createOperatorAlertDebouncer();
    const d = { ...deps, debouncer, logger: spyLogger };

    d.fetchClass = constResult(broke);
    await runPollCycle(d);
    d.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(d);

    expect(lines.some((l) => l.event === 'operator_episode_recovered')).toBe(true);
  });

  it('AC-15a: elapsed time never re-alerts a still-broken episode', async () => {
    const { db, api, notifier, deps } = await makeBed();
    const { id } = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, id);

    // Legacy timing options are intentionally inert: only recovery rearms.
    let nowMs = 1_000_000;
    const debouncer = createOperatorAlertDebouncer({ nowMs: () => nowMs, cooldownMs: 1000 });
    const d = { ...deps, debouncer };

    d.fetchClass = constResult(broke);
    await runPollCycle(d); // episode-open → alert (1)
    nowMs += 500; // still within cooldown
    await runPollCycle(d); // debounced → no alert
    expect(operatorOutbox(notifier.outbox)).toHaveLength(1);

    nowMs += 1000; // beyond the former cooldown
    await runPollCycle(d); // still the same durable episode
    expect(operatorOutbox(notifier.outbox)).toHaveLength(1);
  });

  it('AC-15: a robots-level break across N classes collapses onto ONE operator episode', async () => {
    const { db, api, notifier, deps } = await makeBed();
    // Two distinct classes, both confirmed-watched, both robots-skipped this cycle.
    const a = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, a.id);
    const b = await api.createSubscriber('other@berkeley.edu', [CK2]);
    await confirmSubscriber(db, b.id);

    const debouncer = createOperatorAlertDebouncer();
    // robots-skip parser-broke: detail starts with 'robots.txt:' (host-level).
    const d: PollCycleDeps = {
      ...deps,
      debouncer,
      fetchClass: (k: ClassKey) =>
        Promise.resolve({
          kind: 'parser-broke',
          classKey: k,
          detail: 'robots.txt: unreachable — skipping fetch this cycle',
        } as ParseResult),
    };

    const summary = await runPollCycle(d);

    // Two classes broke, but only ONE operator entry (collapsed robots episode).
    expect(operatorOutbox(notifier.outbox)).toHaveLength(1);
    expect(summary.operatorAlerted).toEqual([ROBOTS_EPISODE_KEY]);
  });

  it('does not let an allowed class recover a persistent robots denial on a sibling path', async () => {
    const { db, api, notifier, deps } = await makeBed();
    const a = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, a.id);
    const b = await api.createSubscriber('robots-sibling@berkeley.edu', [CK2]);
    await confirmSubscriber(db, b.id);
    const debouncer = createOperatorAlertDebouncer();
    const d: PollCycleDeps = {
      ...deps,
      debouncer,
      fetchClass: async (classKey) => {
        if (classKey === CK) {
          return {
            kind: 'parser-broke',
            classKey,
            detail: 'robots.txt: path matches Disallow: /content/private',
          };
        }
        // Ensure the allowed result lands after the denial; the old per-class
        // recovery path then reopened the robots episode every cycle.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          classKey,
          status: 'closed',
          openSeats: 0,
          waitlistOpen: false,
          fetchedAt: new Date().toISOString(),
        };
      },
    };

    await runPollCycle(d);
    await runPollCycle(d);

    expect(operatorOutbox(notifier.outbox)).toHaveLength(1);
  });

  it('AC-15a: a parser-broke cycle never overwrites class_state', async () => {
    const { db, api, repo, deps } = await makeBed();
    const { id } = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, id);

    deps.fetchClass = fakeFetch('zero-seats.html');
    await runPollCycle(deps);
    const before = await repo.getClassState(CK);

    deps.fetchClass = constResult(broke);
    await runPollCycle({ ...deps, debouncer: createOperatorAlertDebouncer() });
    const after = await repo.getClassState(CK);

    expect(after?.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// D13: a simultaneous seat+waitlist opening alerts ONCE (seats-open wins)
// ---------------------------------------------------------------------------

describe('D13: simultaneous seat + waitlist opening → exactly one alert (seats-open wins)', () => {
  beforeEach(() => {
    process.env.TOKEN_SECRET = TOKEN_SECRET;
  });
  afterEach(() => {
    delete process.env.TOKEN_SECRET;
  });

  it('D13: a baseline of closed → a state with open seats AND open waitlist fires one alert', async () => {
    const { db, api, notifier, deps } = await makeBed();
    const { id } = await api.createSubscriber(EMAIL_CONFIRMED, [CK]);
    await confirmSubscriber(db, id);

    // Baseline: 0 seats, waitlist closed.
    deps.fetchClass = constResult({
      classKey: CK,
      status: 'closed',
      openSeats: 0,
      waitlistOpen: false,
      fetchedAt: new Date().toISOString(),
    });
    await runPollCycle(deps);

    // Simultaneous opening: seats > 0 AND waitlist open in the same cycle.
    deps.fetchClass = constResult({
      classKey: CK,
      status: 'open',
      openSeats: 2,
      waitlistOpen: true,
      fetchedAt: new Date().toISOString(),
    });
    const summary = await runPollCycle(deps);

    // Exactly ONE alert per subscriber (a double-opening is not double-alerted).
    expect(alertOutbox(notifier.outbox)).toHaveLength(1);
    expect(summary.notified).toBe(1);
    // seats-open wins: the alert subject names open seats, not waitlist movement.
    expect(alertOutbox(notifier.outbox)[0].subject).toContain('open seats');
  });
});
