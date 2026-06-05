/**
 * src/worker/poller.ts
 *
 * Core of the seat-sniper worker lane: one poll cycle + the long-running
 * scheduler that wraps it with jitter, exponential backoff, and a kill-switch.
 *
 * Design decisions documented here:
 *
 *  ONE fetch per unique class (FR-3 / constitution):
 *    `runPollCycle` calls `fetchClass` exactly once per ClassKey returned by
 *    `getDistinctWatchedClassKeys`, then fans out to every subscriber watching
 *    that class. This is the central reason the poller exists: it decouples
 *    "how many subscribers watch a class" from "how many HTTP requests we make".
 *
 *  Change-detection and dedupe (FR-4, FR-5):
 *    A genuine opening is detected at the WORKER level by comparing the live
 *    SeatState to the last-persisted state in `class_state`. The notifier adds
 *    a second idempotency layer keyed on (subscriberId, classKey, openedAt).
 *    Together these ensure:
 *      - First sighting: baseline upserted, NO notification.
 *      - 0 → >0 transition: fan-out dispatched, state updated.
 *      - Still open on next poll: NO re-notification (prev.lastOpenSeats > 0 guard).
 *      - 0 → 1 → 0 → 1 flap: re-notified ONLY after it closed (lastOpenSeats
 *        returns to 0) and reopened — the notifier's idempotency key changes
 *        because `openedAt` is the timestamp of the NEW opening.
 *
 *  parser-broke handling (FR-6 / AC-5):
 *    A parser-broke result is routed to `notifier.alertOperator`. The class_state
 *    table is NOT overwritten, so the next successful parse still sees the true
 *    last-known state and can detect the transition correctly.
 *
 *  Waitlist transition:
 *    Handled symmetrically: prior.lastWaitlistOpen === false AND new.waitlistOpen
 *    fires a 'waitlist-open' notification.
 *
 *  Backoff (FR-7):
 *    Exponential: baseInterval * 2^attempt, capped at MAX_BACKOFF_MS.
 *    Jitter: +/- up to POLL_JITTER_SECONDS seconds, applied uniformly.
 *    The kill-switch is re-checked at the top of every sleep-wake cycle.
 *
 *  PII (AC-8):
 *    This file never logs subscriber emails or full watch lists. Log lines
 *    carry only classKey, subscriber counts, and cycle-level metrics.
 *
 * Lane: src/worker/** — owned by worker-engineer.
 */

import type { ClassKey } from '../shared/class-key';
import type { ParseResult } from '../shared/seat-state';
import { isParserBroke } from '../shared/seat-state';
import type { Notifier } from '../notify';
import type { WorkerRepo, CycleSummary } from './types';

// ---------------------------------------------------------------------------
// Dependency injection shape
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into `runPollCycle`. All four are required; `now` and
 * `logger` default to sensible production values when omitted.
 *
 * Tests supply fakes for repo, fetchClass, and notifier so the cycle can be
 * driven deterministically against fixture-based ParseResult values without
 * any network or real db.
 */
export interface PollCycleDeps {
  /** Pre-bound db fan-out operations. */
  repo: WorkerRepo;

  /**
   * Fetch one class page and return a ParseResult. In production this is the
   * real `fetchClass` from `../scraper`. Tests inject a fake keyed on classKey.
   * Signature matches the scraper's exported function (minus the opts arg,
   * which the poller does not use — it always uses the default error policy
   * because it handles FetchError-thrown errors at the cycle level).
   */
  fetchClass(classKey: ClassKey): Promise<ParseResult>;

  /** Notifier for subscriber dispatch and operator alerts. */
  notifier: Notifier;

  /**
   * Returns the current time as an ISO-8601 UTC string. Used as `openedAt`
   * in NotifyEvent. Defaults to `() => new Date().toISOString()`. Tests
   * inject a fixed value so idempotency keys are deterministic.
   */
  now?(): string;

  /**
   * Structured logger. Defaults to a JSON-line writer on stdout. Tests inject
   * a no-op or a spy to keep output clean.
   * PII rule: never pass subscriber emails through here (AC-8).
   */
  logger?: Logger;
}

/** Minimal logger interface — one method per log level this module emits. */
export interface Logger {
  info(obj: Record<string, unknown>): void;
  warn(obj: Record<string, unknown>): void;
  error(obj: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Default logger (JSON-line, stdout / stderr)
// ---------------------------------------------------------------------------

function makeDefaultLogger(): Logger {
  function emit(level: string, obj: Record<string, unknown>): void {
    const line = JSON.stringify({ level, ...obj });
    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
  return {
    info: (obj) => emit('info', obj),
    warn: (obj) => emit('warn', obj),
    error: (obj) => emit('error', obj),
  };
}

// ---------------------------------------------------------------------------
// runPollCycle
// ---------------------------------------------------------------------------

/**
 * Execute one complete poll cycle: fetch every watched class once, detect
 * transitions, and fan out notifications to subscribers.
 *
 * Designed for dependency injection so the test-engineer can drive it
 * deterministically (AC-3 / AC-4 / AC-5 / AC-6).
 *
 * Kill-switch (AC-6): if `KILL_SWITCH === '1'`, returns a zero summary
 * immediately — no fetch, no dispatch.
 *
 * PII discipline (AC-8): never logs subscriber emails or full watch lists.
 * Log lines carry only classKey, subscriber counts, and cycle-level metrics.
 */
export async function runPollCycle(deps: PollCycleDeps): Promise<CycleSummary> {
  const { repo, fetchClass, notifier } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.logger ?? makeDefaultLogger();

  // --- Kill-switch (AC-6) ----------------------------------------------------
  if (process.env['KILL_SWITCH'] === '1') {
    log.info({ event: 'poll_cycle_skipped', reason: 'kill-switch active' });
    return { fetched: 0, parserBroke: [], notified: 0, suppressed: 0 };
  }

  // Accumulators for the returned CycleSummary.
  let fetched = 0;
  let notified = 0;
  let suppressed = 0;
  const parserBroke: ClassKey[] = [];

  // --- Build the unique-class fetch queue (FR-3) ----------------------------
  const classKeys = await repo.getDistinctWatchedClassKeys();

  log.info({
    event: 'poll_cycle_start',
    classCount: classKeys.length,
  });

  // --- Process each unique class once ---------------------------------------
  for (const classKey of classKeys) {
    let result: ParseResult;
    try {
      result = await fetchClass(classKey);
      fetched += 1;
    } catch (err) {
      // fetchClass with default opts never throws; if the caller injects a
      // stub that throws (to test backoff paths), we treat the whole cycle as
      // a fetch-error and rethrow so startPoller can apply backoff.
      log.error({
        event: 'fetch_threw',
        classKey,
        error: err instanceof Error ? err.message : String(err),
      });
      // Re-throw so the scheduler can apply backoff — do not swallow and
      // continue, because the error may indicate a systematic problem (e.g.
      // DNS failure) that will affect every class.
      throw err;
    }

    // --- Parser-broke branch (FR-6 / AC-5) -----------------------------------
    if (isParserBroke(result)) {
      parserBroke.push(classKey);
      // Route to operator alert — no class_state overwrite, no subscriber
      // notification. The const `detail` is operator-facing; it must not
      // contain subscriber data (the scraper guarantees this).
      await notifier.alertOperator(classKey, result.detail);
      log.warn({
        event: 'parser_broke',
        classKey,
        detail: result.detail,
      });
      continue; // skip to next class — no upsert
    }

    // --- Successful SeatState branch -----------------------------------------
    const prevState = await repo.getClassState(classKey);

    if (prevState === undefined) {
      // First sighting: establish baseline without notifying (AC-3 rationale —
      // we cannot know whether the class was already open before we started
      // watching; notifying on first poll would be a false positive).
      await repo.upsertClassState({
        classKey,
        lastStatus: result.status,
        lastOpenSeats: result.openSeats,
        lastWaitlistOpen: result.waitlistOpen,
      });
      log.info({
        event: 'class_baseline',
        classKey,
        status: result.status,
        openSeats: result.openSeats,
      });
      continue;
    }

    // Detect a genuine opening transition. There are two independent signals:
    //   1. General-enrollment: prev had NO open seats → new has open seats.
    //   2. Waitlist: prev waitlist was closed → new waitlist is open.
    // Both are checked independently so a class can fire both simultaneously
    // if it transitions on both dimensions in the same poll cycle.

    const seatOpened = prevState.lastOpenSeats === 0 && result.openSeats > 0;
    const waitlistOpened = !prevState.lastWaitlistOpen && result.waitlistOpen;

    if (seatOpened || waitlistOpened) {
      // Genuine transition — fan out to every subscriber watching this class.
      const subscribers = await repo.getSubscribersWatching(classKey);
      const openedAt = now();

      log.info({
        event: 'seats_opened',
        classKey,
        reason: seatOpened ? 'seats-open' : 'waitlist-open',
        openSeats: result.openSeats,
        waitlistOpen: result.waitlistOpen,
        subscriberCount: subscribers.length, // count only — not the list
      });

      for (const sub of subscribers) {
        // Dispatch the reason that triggered the alert. If both seat and
        // waitlist opened simultaneously we prefer 'seats-open' as the more
        // actionable signal.
        const reason = seatOpened ? 'seats-open' : 'waitlist-open';
        let dispatchResult: { sent: boolean; idempotencyKey: string };
        try {
          dispatchResult = await notifier.dispatch({
            subscriberId: sub.id,
            email: sub.email,
            classKey,
            reason,
            openSeats: result.openSeats,
            openedAt,
          });
        } catch (err) {
          // Notifier threw (transport failure). Log and continue fanning out
          // to remaining subscribers rather than abandoning the whole batch.
          // The notifier already released the idempotency key on failure so a
          // retry in the next cycle (or a manual re-run) can re-attempt.
          log.error({
            event: 'dispatch_failed',
            classKey,
            subscriberId: sub.id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        if (dispatchResult.sent) {
          notified += 1;
        } else {
          suppressed += 1;
          log.info({
            event: 'dispatch_suppressed',
            classKey,
            subscriberId: sub.id,
            idempotencyKey: dispatchResult.idempotencyKey,
          });
        }
      }
    } else {
      // No transition: seat was already open (FR-5 dedupe) or still closed/
      // waitlisted in the same state. No notification.
      log.info({
        event: 'no_transition',
        classKey,
        prevOpenSeats: prevState.lastOpenSeats,
        newOpenSeats: result.openSeats,
        prevWaitlistOpen: prevState.lastWaitlistOpen,
        newWaitlistOpen: result.waitlistOpen,
      });
    }

    // Always persist the new state so the next cycle has an accurate baseline.
    // This is what makes FR-5 (flap dedupe) work: if seats close and reopen,
    // the persisted lastOpenSeats goes back to 0, and the next 0→>0 crossing
    // triggers a fresh notification with a new openedAt value (different
    // idempotency key, so the notifier does not suppress it).
    await repo.upsertClassState({
      classKey,
      lastStatus: result.status,
      lastOpenSeats: result.openSeats,
      lastWaitlistOpen: result.waitlistOpen,
    });
  }

  const summary: CycleSummary = { fetched, parserBroke, notified, suppressed };

  log.info({
    event: 'poll_cycle_done',
    fetched,
    parserBrokeCount: parserBroke.length,
    notified,
    suppressed,
  });

  return summary;
}

// ---------------------------------------------------------------------------
// Scheduler helpers
// ---------------------------------------------------------------------------

/** Parse a positive-integer env var, returning `fallback` on invalid input. */
function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Sleep for `ms` milliseconds. Wrapped in a function to allow tests to mock
 * the delay without rewriting the scheduler's control flow.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute a jittered sleep duration in milliseconds.
 *
 * `base` is the nominal interval. `jitterMs` is the maximum additional delay
 * added uniformly at random (± jitter). This spreads burst load over time
 * and prevents herding after a restart.
 */
function jitteredDelay(baseMs: number, jitterMs: number): number {
  // Uniform jitter in [-jitterMs, +jitterMs]. Using `* 2 - 1` maps [0,1) to
  // [-1,+1) so the actual poll interval is `baseMs ± jitterMs`.
  const offset = (Math.random() * 2 - 1) * jitterMs;
  return Math.max(0, baseMs + offset);
}

// ---------------------------------------------------------------------------
// startPoller
// ---------------------------------------------------------------------------

/**
 * Long-running scheduler. Reads config from environment, wires the real
 * dependencies (scraper's `fetchClass`, notifier from `createNotifier`,
 * `createWorkerRepo(getDb())`), and loops forever calling `runPollCycle`.
 *
 * Configuration (FR-7):
 *   POLL_INTERVAL_SECONDS   base poll cadence (default 60 s — polite default)
 *   POLL_JITTER_SECONDS     max ± jitter per cycle (default 10 s)
 *   KILL_SWITCH=1           halt all fetching (checked every cycle)
 *   FETCH_USER_AGENT        operator-identifying User-Agent (required)
 *
 * Backoff: on any thrown error from `runPollCycle`, doubles the wait up to
 * MAX_BACKOFF_MS (10 min), then resets to the base interval on a clean cycle.
 *
 * Never crashes the process — unhappy paths are logged and the loop continues.
 *
 * PII (AC-8): logs only class counts and cycle metrics, never emails.
 */
export async function startPoller(): Promise<void> {
  // Lazy imports for the real dependencies to keep the module graph clean and
  // allow tests to import just `runPollCycle` without pulling in the db/scraper.
  const { fetchClass } = await import('../scraper/index');
  const { createNotifier } = await import('../notify');
  const { getDb } = await import('../db');
  const { createWorkerRepo } = await import('./repo');

  const db = getDb();
  const repo = createWorkerRepo(db);
  const notifier = createNotifier();

  const baseIntervalMs = parseEnvInt(process.env['POLL_INTERVAL_SECONDS'], 60) * 1_000;
  const jitterMs = parseEnvInt(process.env['POLL_JITTER_SECONDS'], 10) * 1_000;
  const MAX_BACKOFF_MS = 10 * 60 * 1_000; // 10 minutes hard cap

  const log = makeDefaultLogger();

  log.info({
    event: 'poller_start',
    pollIntervalSeconds: baseIntervalMs / 1_000,
    pollJitterSeconds: jitterMs / 1_000,
  });

  let consecutiveErrors = 0;

  // The scheduler wraps fetchClass so it always uses the default 'return-broke'
  // error policy (fetchClass never throws under default opts). If a cycle
  // throws for some other unexpected reason we apply backoff and continue.
  async function wrappedFetchClass(classKey: ClassKey): Promise<ParseResult> {
    return fetchClass(classKey);
  }

  while (true) {
    // Kill-switch is also checked inside runPollCycle, but a quick guard here
    // avoids even building the dep graph when the switch is on.
    if (process.env['KILL_SWITCH'] === '1') {
      log.info({ event: 'poller_kill_switch', action: 'skipping cycle' });
      await sleep(jitteredDelay(baseIntervalMs, jitterMs));
      continue;
    }

    try {
      const summary = await runPollCycle({
        repo,
        fetchClass: wrappedFetchClass,
        notifier,
      });

      // Clean cycle — reset backoff.
      consecutiveErrors = 0;

      log.info({
        event: 'poller_cycle_complete',
        fetched: summary.fetched,
        parserBrokeCount: summary.parserBroke.length,
        notified: summary.notified,
        suppressed: summary.suppressed,
      });
    } catch (err) {
      consecutiveErrors += 1;

      // Exponential backoff: baseInterval * 2^(errors-1), capped at max.
      const backoffMs = Math.min(
        baseIntervalMs * Math.pow(2, consecutiveErrors - 1),
        MAX_BACKOFF_MS,
      );

      log.error({
        event: 'poller_cycle_error',
        consecutiveErrors,
        backoffMs,
        error: err instanceof Error ? err.message : String(err),
      });

      await sleep(jitteredDelay(backoffMs, jitterMs));
      continue;
    }

    // Normal sleep between cycles.
    await sleep(jitteredDelay(baseIntervalMs, jitterMs));
  }
}
