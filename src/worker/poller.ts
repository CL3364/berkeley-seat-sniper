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
 *  parser-broke handling (FR-6 / AC-5 / AC-15):
 *    A parser-broke result is routed to `notifier.alertOperator`, but ONLY the
 *    first break of an episode pages the operator — subsequent breaks are
 *    debounced (once-per-broken-episode, FR-14) by `OperatorAlertDebouncer`.
 *    A robots-skip parser-broke (detail starts with `robots.txt:`) is a
 *    HOST-LEVEL condition: all such results collapse onto one synthetic episode
 *    so a robots outage across N classes pages the operator ONCE, not N times.
 *    The class_state table is NEVER overwritten by a broken cycle, so the next
 *    successful parse still sees the true last-known state.
 *
 *  class-gone handling (FR-13 / AC-14):
 *    A class-gone result (404 / recognized not-found page) is EXPECTED lifecycle,
 *    not a bug. The worker retires every live watch on the class
 *    (`repo.retireWatchesForClass`), logs an info event with the classKey + the
 *    retired count, and does NOT page the operator, does NOT notify subscribers,
 *    and does NOT overwrite class_state.
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

import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { ClassKey } from '../shared/class-key';
import type { ParseResult } from '../shared/seat-state';
import { isClassGone, isParserBroke } from '../shared/seat-state';
import type { Notifier } from '../notify';
import { getSendTimeoutMs } from '../notify/timeout';
import { FetchError, isSourceFetchingEnabled } from '../scraper';
import { mintOpeningToken } from '../server/token';
import { createFileSourceOriginControl, type SourceOriginControl } from './source-origin-control';
import { createFileSourceSafetyStopStore, type SourceSafetyStopStore } from './source-safety-stop';
import type { WorkerRepo, CycleSummary } from './types';
import { dashboardObservationsForPersistence } from './dashboard-observations';
import { ROBOTS_EPISODE_KEY, createOperatorAlertDebouncer } from './operator-debounce';
import type { OperatorAlertDebouncer } from './operator-debounce';

/**
 * A robots-skip parser-broke result is overloaded onto the `parser-broke` arm
 * with a `detail` the scraper prefixes with this marker (RFC 9309 posture: a
 * robots.txt 5xx/unreachable makes the worker skip the cycle host-wide). The
 * worker treats these as ONE host-level episode rather than a per-class bug.
 */
const ROBOTS_DETAIL_PREFIX = 'robots.txt:';

// ---------------------------------------------------------------------------
// Manage-token minting (spec §6 — RFC 8058 List-Unsubscribe)
// ---------------------------------------------------------------------------

/**
 * Mint the subscriber's signed manage token for the alert email's one-click
 * unsubscribe header + manage footer link (spec §6). `mintToken` reads
 * `TOKEN_SECRET` from the environment and THROWS when it is missing or shorter
 * than 32 chars (a configuration error, per src/server/token.ts).
 *
 * The poll cycle must never crash on a missing secret in a dev/noop context:
 * here we degrade to dispatching the alert WITHOUT a token — the email channel
 * still works; only the one-click unsubscribe header/footer are best-effort on
 * the token (the notifier already documents this fallback). We log a single
 * WARN per cycle (ids/counts only — never the token, never the email) so the
 * misconfiguration is observable without spamming once per subscriber.
 *
 * Returns `undefined` on failure so the caller passes `undefined` as the
 * second dispatch arg (the contract's omitted-token path).
 */
function mintManageToken(
  subscriberId: string,
  openedAt: string,
  log: Logger,
  warnedRef: { warned: boolean },
): string | undefined {
  try {
    return mintOpeningToken(subscriberId, openedAt);
  } catch {
    if (!warnedRef.warned) {
      warnedRef.warned = true;
      log.warn({
        event: 'manage_token_unavailable',
        classification: 'token_mint_failed',
        impact: 'alerts dispatched without List-Unsubscribe header this cycle',
      });
    }
    return undefined;
  }
}

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
   * Cross-cycle operator-alert debounce (FR-14 / AC-15). Episode state MUST
   * survive between cycles, so the debouncer is created ONCE and reused:
   * `startPoller` constructs one for the lifetime of the process, and a
   * multi-cycle test injects a single shared instance.
   *
   * When omitted, `runPollCycle` creates a FRESH debouncer for that single call
   * — correct for one-shot tests (one alert per broken class in one cycle), but
   * such a caller gets NO cross-cycle debounce. The legacy episode/recovery
   * harness therefore injects a shared instance explicitly.
   */
  debouncer?: OperatorAlertDebouncer;

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

  /**
   * Called after each completed class or delivery attempt. Production uses this
   * to refresh the Docker heartbeat during a long but healthy queue; tests omit
   * it. A heartbeat only at whole-cycle completion caused large queues to be
   * killed and restarted forever before reaching their tail.
   */
  onProgress?(): void;
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

/** Conservative upstream and downstream parallelism caps for the pilot. */
const CLASS_FETCH_CONCURRENCY = 4;
const ALERT_FANOUT_CONCURRENCY = 8;

/**
 * Run every item with at most `limit` promises active. The first rejection is
 * surfaced only after the complete queue settles; no item is launched twice.
 * Continuing after a rejection is intentional: a persistent failure in an
 * early, stably ordered class must not starve every class behind it.
 */
async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let firstFailure: unknown;
  let failed = false;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await task(items[index]);
      } catch (err) {
        if (!failed) firstFailure = err;
        failed = true;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  if (failed) throw firstFailure;
}

/** One FIFO concurrency budget shared by every alert source in a cycle. */
function createConcurrencyLimiter(limit: number) {
  let active = 0;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  function release(): void {
    const next = waiters.shift();
    if (next) {
      // Transfer this permit directly; `active` stays unchanged.
      next();
    } else {
      active -= 1;
    }
  }

  return async function limited<T>(task: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/**
 * Incrementally-fed FIFO with a fixed worker count. Openings can enqueue sends
 * as soon as their transition transaction commits without allocating one
 * waiting promise per recipient or occupying the class-fetch workers.
 */
function createConcurrentTaskQueue<T>(limit: number, task: (item: T) => Promise<void>) {
  const items: T[] = [];
  const workers = new Set<Promise<void>>();
  let cursor = 0;
  let firstFailure: unknown;
  let failed = false;

  function start(): void {
    while (workers.size < limit && cursor < items.length) {
      const worker = (async () => {
        while (true) {
          const index = cursor;
          if (index >= items.length) return;
          cursor += 1;
          try {
            await task(items[index]!);
          } catch (error) {
            if (!failed) firstFailure = error;
            failed = true;
          }
        }
      })();
      workers.add(worker);
      void worker.finally(() => {
        workers.delete(worker);
        start();
      });
    }
  }

  return {
    add(next: readonly T[]): void {
      items.push(...next);
      start();
    },
    async drain(): Promise<void> {
      start();
      while (workers.size > 0) {
        await Promise.all([...workers]);
      }
      if (failed) throw firstFailure;
    },
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
 * Kill-switch (AC-6): unless `KILL_SWITCH === '0'`, returns a zero summary
 * immediately — no fetch, no dispatch.
 *
 * PII discipline (AC-8): never logs subscriber emails or full watch lists.
 * Log lines carry only classKey, subscriber counts, and cycle-level metrics.
 */
export async function runPollCycle(deps: PollCycleDeps): Promise<CycleSummary> {
  const { repo, fetchClass, notifier } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.logger ?? makeDefaultLogger();
  const onProgress = deps.onProgress ?? (() => undefined);
  // Single-call default: a fresh debouncer means "one alert per broken class
  // this cycle" with no cross-cycle memory. Multi-cycle callers (startPoller,
  // AC-15 tests) inject a shared instance so episode state persists.
  const debouncer = deps.debouncer ?? createOperatorAlertDebouncer();

  // --- Kill-switch (AC-6) ----------------------------------------------------
  if (!isSourceFetchingEnabled()) {
    log.info({ event: 'poll_cycle_skipped', reason: 'kill-switch active' });
    return {
      fetched: 0,
      parserBroke: [],
      notified: 0,
      suppressed: 0,
      addressSuppressed: 0,
      classGone: [],
      operatorAlerted: [],
      sourceDisabled: true,
      healthy: false,
    };
  }

  // Accumulators for the returned CycleSummary. JavaScript runs each increment
  // synchronously even though class/subscriber tasks are interleaved.
  let fetched = 0;
  let notified = 0;
  // Two DISTINCT §6 metrics that must not be conflated: `suppressed` counts the
  // notifier's idempotency DEDUPE no-ops ({sent:false, suppressed:false});
  // `addressSuppressed` counts SUPPRESSED-ADDRESS skips ({sent:false,
  // suppressed:true}, FR-12). DispatchResult tells them apart.
  let suppressed = 0;
  let addressSuppressed = 0;
  let robotsSkipped = 0;
  let deliveryDeferred = 0;
  const parserBroke: ClassKey[] = [];
  const classGone: ClassKey[] = [];
  const operatorAlerted: string[] = [];
  // Latches the "TOKEN_SECRET missing → minting failed" warning so it is logged
  // at most ONCE per cycle, not once per subscriber (§6 degrade-and-warn-once).
  const tokenWarned = { warned: false };

  const cycleNow = now();
  const staleAfterMs = parseEnvInt(process.env['POLL_INTERVAL_SECONDS'], 30) * 10 * 1_000;
  const retryWindowMs = parseEnvInt(process.env['POLL_INTERVAL_SECONDS'], 30) * 1_000 + 5_000;
  const sendTimeoutMs = getSendTimeoutMs();
  const withAlertPermit = createConcurrencyLimiter(ALERT_FANOUT_CONCURRENCY);

  interface DeliveryStartBudget {
    deadlineMs: number;
    starts: number;
  }

  /** Mark a successfully handled (sent, provider-deduped, or suppressed) row. */
  async function completeDelivery(delivery: {
    subscriberId: string;
    classKey: ClassKey;
    openedAt: string;
  }): Promise<void> {
    try {
      await repo.markAlertDeliverySent(delivery);
      onProgress();
    } catch {
      // Leave the row pending. A later cycle retries it with the same provider
      // idempotency key, so a send-success/mark-failure cannot duplicate email.
      log.error({
        event: 'delivery_mark_failed',
        classKey: delivery.classKey,
        subscriberId: delivery.subscriberId,
        classification: 'delivery_repository_failed',
      });
      onProgress();
      await repo.deferAlertDelivery?.(delivery);
      onProgress();
    }
  }

  /** Dispatch one already-claimed ledger row without blocking sibling rows. */
  async function dispatchClaimed(
    delivery: {
      subscriberId: string;
      email: string;
      classKey: ClassKey;
      openedAt: string;
      reason: 'seats-open' | 'waitlist-open';
      openSeats: number;
    },
    budget: DeliveryStartBudget,
  ): Promise<void> {
    try {
      await withAlertPermit(async () => {
        if (budget.starts >= ALERT_FANOUT_CONCURRENCY && Date.now() >= budget.deadlineMs) {
          deliveryDeferred += 1;
          return;
        }
        budget.starts += 1;
        const current = repo.getEligibleAlertDelivery
          ? await repo.getEligibleAlertDelivery(delivery)
          : delivery;
        onProgress();
        if (!current) {
          await repo.cancelAlertDelivery?.(delivery);
          log.info({
            event: 'delivery_cancelled_ineligible',
            classKey: delivery.classKey,
            subscriberId: delivery.subscriberId,
          });
          return;
        }
        delivery = current;

        let dispatchResult: Awaited<ReturnType<typeof notifier.dispatch>>;
        try {
          const manageToken = mintManageToken(
            delivery.subscriberId,
            delivery.openedAt,
            log,
            tokenWarned,
          );
          dispatchResult = await notifier.dispatch(
            {
              subscriberId: delivery.subscriberId,
              email: delivery.email,
              classKey: delivery.classKey,
              reason: delivery.reason,
              openSeats: delivery.openSeats,
              openedAt: delivery.openedAt,
            },
            manageToken,
          );
          onProgress();
        } catch {
          // The ledger row remains pending. Other recipients continue immediately;
          // the next cycle retries this exact opening.
          log.error({
            event: 'dispatch_failed',
            classKey: delivery.classKey,
            subscriberId: delivery.subscriberId,
            classification: 'mail_dispatch_failed',
          });
          onProgress();
          await repo.deferAlertDelivery?.(delivery);
          onProgress();
          return;
        }

        if (dispatchResult.sent) {
          notified += 1;
        } else if (dispatchResult.suppressed) {
          addressSuppressed += 1;
          log.info({
            event: 'dispatch_suppressed',
            classKey: delivery.classKey,
            subscriberId: delivery.subscriberId,
            idempotencyKey: dispatchResult.idempotencyKey,
          });
        } else {
          // A local/provider replay no-op is terminal for this ledger row.
          suppressed += 1;
          log.info({
            event: 'dispatch_deduped',
            classKey: delivery.classKey,
            subscriberId: delivery.subscriberId,
            idempotencyKey: dispatchResult.idempotencyKey,
          });
        }

        await completeDelivery(delivery);
      });
    } finally {
      onProgress();
    }
  }

  const freshDeliveryQueue = createConcurrentTaskQueue<{
    delivery: Parameters<typeof dispatchClaimed>[0];
    budget: DeliveryStartBudget;
  }>(ALERT_FANOUT_CONCURRENCY, ({ delivery, budget }) => dispatchClaimed(delivery, budget));

  // Claimed-but-unmarked rows survive process restarts. Drain a finite batch
  // before scraping so a later state change cannot starve an older opening.
  const pending = await repo.listPendingAlertDeliveries();
  onProgress();
  if (pending.length > 0) {
    log.info({ event: 'delivery_retry_start', count: pending.length });
  }

  // --- Build the unique-class fetch queue (FR-3) ----------------------------
  const classKeys = await repo.getDistinctWatchedClassKeys();
  onProgress();
  // Capture one database-clock boundary before any network request. A
  // class-gone observation may retire only watches represented by this cycle;
  // an add/revival that commits while the fetch is in flight must survive for a
  // fresh re-test next cycle.
  const classGoneCutoff = await repo.getPollCycleCutoff();
  onProgress();

  log.info({
    event: 'poll_cycle_start',
    classCount: classKeys.length,
  });

  // --- Process each unique class once, with a polite fixed concurrency cap --
  const classWork = forEachConcurrent(classKeys, CLASS_FETCH_CONCURRENCY, async (classKey) => {
    let result: ParseResult;
    try {
      result = await fetchClass(classKey);
      fetched += 1;
      onProgress();
    } catch (err) {
      // The fetch timeout is one bounded operation; refresh before an optional
      // operator-provider send so their separate deadlines never accumulate
      // into one liveness silence window.
      onProgress();
      // An unreadable robots.txt must both activate scheduler backoff AND page
      // the operator. `fetchClass` throws this transient condition so the outer
      // loop backs off; handle the host-level episode before preserving the
      // throw. Without this bridge, production never reached the parser-broke
      // branch below and a persistent robots outage was visible only in logs.
      if (err instanceof FetchError && err.detail.startsWith(ROBOTS_DETAIL_PREFIX)) {
        robotsSkipped += 1;
        const decision = debouncer.observeBroken(classKey, 'robots');
        if (decision.shouldAlert && decision.reason !== 'debounced') {
          try {
            await notifier.alertOperator(classKey, err.detail);
            operatorAlerted.push(ROBOTS_EPISODE_KEY);
            log.warn({
              event: 'parser_broke',
              classKey,
              episodeKey: ROBOTS_EPISODE_KEY,
              reason: decision.reason,
              classification: 'robots_unavailable',
            });
          } catch {
            debouncer.alertFailed(classKey, 'robots', decision.reason);
            log.error({
              event: 'operator_alert_failed',
              classKey,
              episodeKey: ROBOTS_EPISODE_KEY,
              classification: 'operator_mail_failed',
            });
          }
        } else {
          log.info({
            event: 'parser_broke_debounced',
            classKey,
            episodeKey: ROBOTS_EPISODE_KEY,
            reason: decision.reason,
            classification: 'robots_unavailable',
          });
        }
      }
      // Transient network/HTTP failures throw by default so the scheduler's
      // exponential backoff is exercised.
      log.error({
        event: 'fetch_threw',
        classKey,
        classification:
          err instanceof FetchError ? 'source_fetch_failed' : 'unexpected_source_failure',
      });
      onProgress();
      throw err;
    }

    // --- Class-gone branch (FR-13 / AC-14) -----------------------------------
    if (isClassGone(result)) {
      for (const recoveredKey of debouncer.recover(classKey)) {
        log.info({ event: 'operator_episode_recovered', classKey, episodeKey: recoveredKey });
      }
      // The page no longer exists (404 / recognized not-found). This is EXPECTED
      // lifecycle, not a bug: retire every live watch on the class so it stops
      // being polled / listed, and do NOT page the operator, do NOT notify
      // subscribers, and do NOT overwrite class_state. `retireWatchesForClass`
      // is idempotent and returns the count of rows retired this call.
      const retiredCount = await repo.retireWatchesForClass(classKey, classGoneCutoff);
      classGone.push(classKey);
      log.info({
        event: 'class_gone',
        classKey,
        retiredCount, // count only — never the rows / PII
      });
      onProgress();
      return; // no upsert, no operator page, no subscriber alert
    }

    // --- Parser-broke branch (FR-6 / AC-5 / AC-15) ---------------------------
    if (isParserBroke(result)) {
      parserBroke.push(classKey);

      // A robots-skip parser-broke (detail prefixed `robots.txt:`) is a
      // HOST-LEVEL condition, not a per-class parser bug — all such results
      // collapse onto ONE synthetic episode so a robots outage across N classes
      // pages the operator once, not N times (RFC 9309 posture).
      const isRobotsSkip = result.detail.startsWith(ROBOTS_DETAIL_PREFIX);
      if (isRobotsSkip) robotsSkipped += 1;
      const decision = debouncer.observeBroken(classKey, isRobotsSkip ? 'robots' : 'parser-broke');

      if (decision.shouldAlert && decision.reason !== 'debounced') {
        // Page the operator — debounced to once per broken episode (FR-14).
        // No class_state overwrite, no subscriber notification. `detail` is
        // operator-facing; the scraper guarantees it carries no subscriber PII.
        const alertKey = isRobotsSkip ? ROBOTS_EPISODE_KEY : classKey;
        try {
          await notifier.alertOperator(classKey, result.detail);
          operatorAlerted.push(alertKey);
          log.warn({
            event: 'parser_broke',
            classKey,
            episodeKey: alertKey,
            reason: decision.reason,
            classification: isRobotsSkip ? 'robots_unavailable' : 'parser_broke',
          });
        } catch {
          debouncer.alertFailed(
            classKey,
            isRobotsSkip ? 'robots' : 'parser-broke',
            decision.reason,
          );
          log.error({
            event: 'operator_alert_failed',
            classKey,
            episodeKey: alertKey,
            classification: 'operator_mail_failed',
          });
        }
      } else {
        // A still-open episode always suppresses the duplicate page; elapsed
        // time never re-arms it.
        log.info({
          event: 'parser_broke_debounced',
          classKey,
          episodeKey: isRobotsSkip ? ROBOTS_EPISODE_KEY : classKey,
          reason: decision.reason, // 'debounced'
          classification: isRobotsSkip ? 'robots_unavailable' : 'parser_broke',
        });
      }
      onProgress();
      return; // no state overwrite
    }

    // --- Successful SeatState branch -----------------------------------------
    // A clean parse proves the page (and the host) is reachable: close any open
    // operator-alert episode for this class AND the host-level robots episode,
    // logging a recovery per FR-14 so the next break alerts again (AC-15).
    for (const recoveredKey of debouncer.recover(classKey)) {
      log.info({
        event: 'operator_episode_recovered',
        classKey,
        episodeKey: recoveredKey,
      });
    }

    const prevState = await repo.getClassState(classKey);
    onProgress();

    if (prevState === undefined) {
      // First sighting: establish baseline without notifying (AC-3 rationale —
      // we cannot know whether the class was already open before we started
      // watching; notifying on first poll would be a false positive).
      await repo.upsertClassState({
        classKey,
        lastStatus: result.status,
        lastOpenSeats: result.openSeats,
        lastWaitlistOpen: result.waitlistOpen,
        ...dashboardObservationsForPersistence(result),
      });
      log.info({
        event: 'class_baseline',
        classKey,
        status: result.status,
        openSeats: result.openSeats,
      });
      onProgress();
      return;
    }

    // A state older than ten poll intervals may describe an opening that
    // occurred while nobody was watching or while the worker was down. Treat
    // the next successful observation as a fresh baseline, never a transition.
    const observedNow = now();
    const parsedObservedNow = Date.parse(observedNow);
    const observedNowMs = Number.isFinite(parsedObservedNow) ? parsedObservedNow : Date.now();
    if (observedNowMs - prevState.updatedAt.getTime() > staleAfterMs) {
      await repo.upsertClassState({
        classKey,
        lastStatus: result.status,
        lastOpenSeats: result.openSeats,
        lastWaitlistOpen: result.waitlistOpen,
        ...dashboardObservationsForPersistence(result),
      });
      log.info({
        event: 'class_rebaseline_stale',
        classKey,
        staleForMs: observedNowMs - prevState.updatedAt.getTime(),
      });
      onProgress();
      return;
    }

    // Detect a genuine opening transition. There are two independent signals:
    //   1. General-enrollment: prev had NO open seats → new has open seats.
    //   2. Waitlist: prev waitlist was closed → new waitlist is open.
    // Both are checked independently so a class can fire both simultaneously
    // if it transitions on both dimensions in the same poll cycle.

    const seatOpened = prevState.lastOpenSeats === 0 && result.openSeats > 0;
    const waitlistOpened = !prevState.lastWaitlistOpen && result.waitlistOpen;

    if (seatOpened || waitlistOpened) {
      const reason = seatOpened ? 'seats-open' : 'waitlist-open';
      // Commit the state transition and every confirmed recipient claim in one
      // transaction. Dispatch happens only after that transaction commits.
      const deliveries = await repo.claimOpeningDeliveries({
        classKey,
        previousStateVersion: prevState.stateVersion,
        openedAt: cycleNow,
        reason,
        openSeats: result.openSeats,
        nextState: {
          lastStatus: result.status,
          lastOpenSeats: result.openSeats,
          lastWaitlistOpen: result.waitlistOpen,
          ...dashboardObservationsForPersistence(result),
        },
      });

      log.info({
        event: 'seats_opened',
        classKey,
        reason: seatOpened ? 'seats-open' : 'waitlist-open',
        openSeats: result.openSeats,
        waitlistOpen: result.waitlistOpen,
        subscriberCount: deliveries.length,
      });

      // Claims are durable. Feed them to an independent bounded FIFO now so an
      // early opening is not held behind unrelated slow class fetches. Sending
      // still cannot occupy a class-fetch worker or exceed the global cap.
      const budget: DeliveryStartBudget = {
        // Each opening owns its detection-to-send window. A late class must not
        // inherit an expired cycle-global budget consumed by an earlier class.
        deadlineMs: Date.now() + Math.max(0, retryWindowMs - sendTimeoutMs),
        starts: 0,
      };
      freshDeliveryQueue.add(deliveries.map((delivery) => ({ delivery, budget })));
      onProgress();
      return; // state was committed atomically with the claims
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
      ...dashboardObservationsForPersistence(result),
    });
    onProgress();
  });
  // Resolve current class lifecycle before replaying older sends. In particular,
  // a class-gone result retires its watches first, so the just-in-time delivery
  // check cancels stale rows instead of emailing during the retirement cycle.
  let classWorkFailed = false;
  let classWorkError: unknown;
  try {
    await classWork;
  } catch (error) {
    // `forEachConcurrent` completes every class before surfacing its first
    // error. Preserve that error for scheduler backoff, but do not let one
    // broken upstream class starve durable claims made by healthy classes.
    classWorkFailed = true;
    classWorkError = error;
  }
  // Give the opening detected now first use of the notify SLO; an old retry
  // backlog must not delay every fresh alert for hours. Both phases retain a
  // guaranteed bounded wave, so repeated openings cannot starve old rows.
  await freshDeliveryQueue.drain();
  const retryBudget: DeliveryStartBudget = {
    deadlineMs: Date.now() + Math.max(0, retryWindowMs - sendTimeoutMs),
    starts: 0,
  };
  await forEachConcurrent(pending, ALERT_FANOUT_CONCURRENCY, (delivery) =>
    dispatchClaimed(delivery, retryBudget),
  );
  if (deliveryDeferred > 0) {
    log.info({ event: 'delivery_deferred_cycle_budget', count: deliveryDeferred });
  }

  if (classWorkFailed) {
    throw classWorkError;
  }

  // A robots policy may allow one class path while denying another. Recover the
  // host-level episode only after the complete cycle saw no robots skips; an
  // allowed sibling must not repeatedly reset a persistent denial.
  if (classKeys.length > 0 && robotsSkipped === 0) {
    for (const recoveredKey of debouncer.recoverRobots()) {
      log.info({ event: 'operator_episode_recovered', episodeKey: recoveredKey });
    }
  }

  // Parallel processing order is deliberately irrelevant; sort identifier-only
  // arrays so logs/tests remain deterministic.
  parserBroke.sort();
  classGone.sort();
  operatorAlerted.sort();

  const summary: CycleSummary = {
    fetched,
    parserBroke,
    notified,
    suppressed,
    addressSuppressed,
    classGone,
    operatorAlerted,
  };

  log.info({
    event: 'poll_cycle_done',
    fetched,
    parserBrokeCount: parserBroke.length,
    classGoneCount: classGone.length,
    operatorAlertedCount: operatorAlerted.length,
    notified,
    suppressed,
    addressSuppressed,
  });

  return summary;
}

// ---------------------------------------------------------------------------
// Scheduler helpers
// ---------------------------------------------------------------------------

/** Parse a positive-integer env var, returning `fallback` on invalid input. */
function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function requirePositiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export interface WorkerHealthWindowConfig {
  baseIntervalMs: number;
  jitterMs: number;
  maxBackoffMs: number;
  workerHealthMaxStaleMs: number;
  dbConnectTimeoutMs: number;
  dbQueryTimeoutMs: number;
  fetchTimeoutMs: number;
  sendTimeoutMs: number;
}

/**
 * Keep Docker's liveness deadline outside every intentional scheduler sleep.
 * Without this cross-field check, individually valid tunables can guarantee a
 * restart loop (for example a 30-minute cadence with a 15-minute heartbeat).
 *
 * Progress is refreshed on both sides of scheduler sleeps and between bounded
 * operations. The remaining no-progress allowance covers the longest single
 * repository transaction (pool acquisition + BEGIN + five claim statements +
 * COMMIT, with a possible ROLLBACK after a deadline failure), a robots+class
 * fetch pair, or one suppression-query/send sequence. An extra minute covers
 * healthcheck cadence and ordinary scheduler delay.
 */
export function validateWorkerHealthWindow(config: WorkerHealthWindowConfig): void {
  const maxSleepMs = Math.max(config.baseIntervalMs, config.maxBackoffMs) + config.jitterMs;
  const maxClaimTransactionMs = config.dbConnectTimeoutMs + 8 * config.dbQueryTimeoutMs;
  const maxSuppressionAndSendMs =
    config.dbConnectTimeoutMs + config.dbQueryTimeoutMs + config.sendTimeoutMs;
  const maxBoundedOperationMs = Math.max(
    maxClaimTransactionMs,
    2 * config.fetchTimeoutMs,
    maxSuppressionAndSendMs,
  );
  const minimumStaleMs = Math.max(maxSleepMs, maxBoundedOperationMs) + 60_000;

  if (config.workerHealthMaxStaleMs <= minimumStaleMs) {
    throw new Error(
      'WORKER_HEALTH_MAX_STALE_SECONDS is too short for the configured poll/backoff ' +
        `window; require more than ${Math.ceil(minimumStaleMs / 1_000)} seconds`,
    );
  }
}

export async function inspectWorkerSourceDisabled(
  safetyStop: SourceSafetyStopStore,
  originControl: SourceOriginControl,
): Promise<boolean> {
  if (!isSourceFetchingEnabled()) return true;
  const [safetyState, originState] = await Promise.all([
    safetyStop
      .inspect()
      .catch(() => ({ stopped: true, classification: 'marker_unreadable' }) as const),
    originControl
      .inspect()
      .catch(() => ({ blocked: true, classification: 'origin_fence_unavailable' }) as const),
  ]);
  return safetyState.stopped || originState.blocked;
}

/** Require an identifying production scraper UA with a real contact channel. */
function requireContactableFetchUserAgent(): void {
  const value = process.env.FETCH_USER_AGENT?.trim();
  const hasContact =
    value !== undefined &&
    (/(?:mailto:)[^\s()<>@]+@[^\s()<>@]+\.[^\s()<>@]+/i.test(value) ||
      /https:\/\/[^\s()<>]+/i.test(value));
  const isPlaceholder =
    value === undefined || /(?:^|[.@])example\.(?:com|org|net|edu)\b/i.test(value);
  if (!hasContact || isPlaceholder) {
    throw new Error(
      'FETCH_USER_AGENT must identify this deployment with a real mailto: address ' +
        'or HTTPS operator page; placeholder example domains are not allowed.',
    );
  }
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

export interface StartPollerOptions {
  signal?: AbortSignal;
}

function combinePollerAbortSignals(
  outerSignal: AbortSignal | undefined,
  ownerSignal: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  if (!outerSignal || outerSignal === ownerSignal) {
    return { signal: ownerSignal, dispose: () => undefined };
  }
  const controller = new AbortController();
  const signals = [outerSignal, ownerSignal];
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
    dispose(): void {
      for (const signal of signals) signal.removeEventListener('abort', abort);
    },
  };
}

/**
 * Long-running v0.4 worker. Only the PostgreSQL advisory-lease owner may touch
 * the source or outbox. Source failures remain per-Section; only infrastructure
 * failures engage the process-level backoff.
 */
export async function startPoller(options: StartPollerOptions = {}): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.RESPECT_ROBOTS === '0') {
    throw new Error(
      'worker refusing to start: RESPECT_ROBOTS=0 is allowed only outside production',
    );
  }
  // Construct this before source-config validation: an already-latched worker
  // must remain able to drain mail/retention even if source-only configuration
  // is being repaired during Operator review.
  const sourceOriginControl = createFileSourceOriginControl();
  const sourceSafetyStop = createFileSourceSafetyStopStore({
    originControl: sourceOriginControl,
  });
  const sourceDisabledAtStartup = await inspectWorkerSourceDisabled(
    sourceSafetyStop,
    sourceOriginControl,
  );
  if (!sourceDisabledAtStartup) {
    requireContactableFetchUserAgent();
  }

  const [
    { createPublicClassPageSource },
    { createMailDispatcher },
    { getDb, tryAcquireWorkerAdvisoryLease },
    { createWorkerRepo },
    {
      SourceScheduleState,
      abortableSleep,
      createMaintenanceState,
      readV04WorkerConfig,
      runOutboxDispatchCycle,
      runSourcePollCycle,
    },
  ] = await Promise.all([
    import('../scraper/index'),
    import('../notify'),
    import('../db'),
    import('./repo'),
    import('./v04'),
  ]);

  const config = readV04WorkerConfig();
  const maxConsecutiveErrors = requirePositiveEnvInt('MAX_CONSECUTIVE_CYCLE_FAILURES', 8);
  const workerHealthMaxStaleSeconds = requirePositiveEnvInt('WORKER_HEALTH_MAX_STALE_SECONDS', 900);
  validateWorkerHealthWindow({
    baseIntervalMs: config.pollHeartbeatMs,
    jitterMs: config.pollJitterMs,
    maxBackoffMs: config.maxBackoffMs,
    workerHealthMaxStaleMs: workerHealthMaxStaleSeconds * 1_000,
    dbConnectTimeoutMs: requirePositiveEnvInt('DB_CONNECT_TIMEOUT_MS', 5_000),
    dbQueryTimeoutMs: requirePositiveEnvInt('DB_QUERY_TIMEOUT_MS', 20_000),
    fetchTimeoutMs: requirePositiveEnvInt('FETCH_TIMEOUT_MS', 10_000),
    sendTimeoutMs: getSendTimeoutMs(),
  });

  const db = getDb();
  const repo = createWorkerRepo(db);
  const dispatcher = createMailDispatcher();
  const log = makeDefaultLogger();
  const needsLease = Boolean(process.env.DATABASE_URL?.trim());
  if (!needsLease && process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required for the production worker advisory lease');
  }

  log.info({
    event: 'poller_start',
    sourceRequestsPerSecond: config.sourceRequestsPerSecond,
    sourceVisibleTargetSeconds: config.sourceVisibleTargetMs / 1_000,
    outboxBatchSize: config.outboxBatchSize,
    outboxClaimLeaseSeconds: config.outboxClaimLeaseSeconds,
    advisoryLease: needsLease ? 'required' : 'development-disabled',
  });

  let leaseAttemptFailures = 0;
  while (!options.signal?.aborted) {
    let lease: Awaited<ReturnType<typeof tryAcquireWorkerAdvisoryLease>> | undefined;
    if (needsLease) {
      try {
        lease = await tryAcquireWorkerAdvisoryLease();
        leaseAttemptFailures = 0;
      } catch {
        leaseAttemptFailures += 1;
        const delayMs = Math.min(
          config.pollHeartbeatMs * Math.pow(2, Math.min(leaseAttemptFailures - 1, 20)),
          config.maxBackoffMs,
        );
        log.error({
          event: 'worker_lease_acquire_failed',
          classification: 'lease_dependency_failed',
          retryInMs: delayMs,
        });
        await abortableSleep(delayMs, options.signal);
        continue;
      }
      if (!lease) {
        log.info({ event: 'worker_lease_standby', retryInMs: config.pollHeartbeatMs });
        await abortableSleep(config.pollHeartbeatMs, options.signal);
        continue;
      }
    }

    const heartbeat = createWorkerHeartbeat();
    const source = createPublicClassPageSource({ onNetworkError: 'throw' });
    const schedule = new SourceScheduleState();
    const maintenance = createMaintenanceState();
    const debouncer = createOperatorAlertDebouncer();
    let leaseLost = false;

    // Only the lease owner may replace the shared marker. A standby never
    // removes or refreshes the active worker's readiness record.
    heartbeat.reset();
    heartbeat.recordProgress();
    log.info({ event: 'worker_lease_acquired' });

    const ownerAbort = new AbortController();
    const ownerScope = combinePollerAbortSignals(options.signal, ownerAbort.signal);
    const ownerSignal = ownerScope.signal;
    const sourceDisabledAtLease = await inspectWorkerSourceDisabled(
      sourceSafetyStop,
      sourceOriginControl,
    );
    let sourceState: { healthy: boolean; disabled: boolean; sourceStaleCount: number } = {
      healthy: false,
      disabled: sourceDisabledAtLease,
      sourceStaleCount: 1,
    };
    let outboxState:
      | {
          healthy: boolean;
          queued: number;
          processing: number;
          deadLetter: number;
          oldestQueuedAgeMs: number | null;
        }
      | undefined;

    function publishAggregateHealth(sourceSucceeded: boolean): void {
      const health: WorkerHealthSnapshot = {
        sourceStaleCount: sourceState?.sourceStaleCount ?? 1,
        outboxQueued: outboxState?.queued ?? 0,
        outboxProcessing: outboxState?.processing ?? 0,
        outboxDeadLetter: outboxState?.deadLetter ?? 0,
        outboxOldestQueuedAgeMs: outboxState?.oldestQueuedAgeMs ?? null,
      };
      const disabled = !isSourceFetchingEnabled() || sourceState?.disabled === true;
      heartbeat.recordStatus(health, {
        healthy: sourceState?.healthy === true && !disabled && outboxState?.healthy === true,
        disabled,
        sourceSucceeded,
      });
    }

    async function runSourceLoop(): Promise<void> {
      let consecutiveErrors = 0;
      while (!ownerSignal.aborted) {
        const sourceDisabledBeforeCycle = await inspectWorkerSourceDisabled(
          sourceSafetyStop,
          sourceOriginControl,
        );
        if (!sourceDisabledBeforeCycle) {
          requireContactableFetchUserAgent();
        } else {
          sourceState = {
            healthy: false,
            disabled: true,
            sourceStaleCount: sourceState.sourceStaleCount,
          };
          publishAggregateHealth(false);
        }
        try {
          const summary = await runSourcePollCycle({
            repo,
            source,
            mailDispatcher: dispatcher,
            schedule,
            maintenance,
            config,
            debouncer,
            logger: log,
            signal: ownerSignal,
            onProgress: heartbeat.recordProgress,
            sourceSafetyStop,
            sourceOriginControl,
          });
          if (ownerSignal.aborted) return;
          consecutiveErrors = 0;
          sourceState = {
            healthy: summary.healthy === true,
            disabled: summary.sourceDisabled === true,
            sourceStaleCount: summary.sourceStaleCount ?? 0,
          };
          publishAggregateHealth(summary.healthy === true);
          log.info({
            event: 'source_cycle_complete',
            fetched: summary.fetched,
            parserBrokeCount: summary.parserBroke.length,
            classGoneCount: summary.classGone?.length ?? 0,
            sourceFailures: summary.sourceFailures ?? 0,
            sourceDisabled: summary.sourceDisabled === true,
            healthy: summary.healthy === true,
          });

          const nextSourceAt = summary.nextSourceCheckAt
            ? Date.parse(summary.nextSourceCheckAt)
            : Number.NaN;
          const nextDelayMs = Number.isFinite(nextSourceAt)
            ? Math.max(0, nextSourceAt - Date.now())
            : config.pollHeartbeatMs;
          await abortableSleep(Math.min(config.pollHeartbeatMs, nextDelayMs), ownerSignal);
          heartbeat.recordProgress();
        } catch (error) {
          if (ownerSignal.aborted) return;
          consecutiveErrors += 1;
          const backoffMs = Math.min(
            config.pollHeartbeatMs * Math.pow(2, consecutiveErrors - 1),
            config.maxBackoffMs,
          );
          sourceState = {
            healthy: false,
            disabled: await inspectWorkerSourceDisabled(sourceSafetyStop, sourceOriginControl),
            sourceStaleCount: sourceState.sourceStaleCount,
          };
          publishAggregateHealth(false);
          log.error({
            event: 'source_cycle_error',
            consecutiveErrors,
            backoffMs,
            classification: 'source_cycle_failed',
          });
          if (consecutiveErrors >= maxConsecutiveErrors) {
            throw new Error('source scheduler failure threshold exceeded', {
              cause: error,
            });
          }
          await abortableSleep(jitteredDelay(backoffMs, config.pollJitterMs), ownerSignal);
          heartbeat.recordProgress();
        }
      }
    }

    async function runDispatcherLoop(): Promise<void> {
      let consecutiveErrors = 0;
      while (!ownerSignal.aborted) {
        try {
          const summary = await runOutboxDispatchCycle({
            repo,
            mailDispatcher: dispatcher,
            maintenance,
            config,
            logger: log,
            signal: ownerSignal,
            onProgress: heartbeat.recordProgress,
          });
          if (ownerSignal.aborted) return;
          consecutiveErrors = 0;
          outboxState = {
            healthy: summary.healthy,
            queued: summary.outboxQueued,
            processing: summary.outboxProcessing,
            deadLetter: summary.outboxDeadLetter,
            oldestQueuedAgeMs: summary.outboxOldestQueuedAgeMs,
          };
          publishAggregateHealth(false);
          log.info({
            event: 'outbox_cycle_complete',
            mailClaimed: summary.claimed,
            mailSent: summary.sent,
            mailDeferred: summary.deferred,
            mailCancelledExpired: summary.expired + summary.cancelledExpired,
            mailDeadLettered: summary.deadLettered,
            incidentsClaimed: summary.incidentsClaimed,
            incidentsPublished: summary.incidentsPublished,
            incidentPublishDeferred: summary.incidentPublishDeferred,
            incidentSurfaceFenceLost: summary.incidentSurfaceFenceLost,
            outboxDeadLetter: summary.outboxDeadLetter,
            healthy: summary.healthy,
          });

          const idleDelayMs = Math.min(config.pollHeartbeatMs, 1_000);
          await abortableSleep(summary.claimed > 0 ? 100 : idleDelayMs, ownerSignal);
          heartbeat.recordProgress();
        } catch (error) {
          if (ownerSignal.aborted) return;
          consecutiveErrors += 1;
          const backoffMs = Math.min(
            1_000 * Math.pow(2, Math.min(consecutiveErrors - 1, 20)),
            config.maxBackoffMs,
          );
          outboxState = {
            healthy: false,
            queued: outboxState?.queued ?? 0,
            processing: outboxState?.processing ?? 0,
            deadLetter: outboxState?.deadLetter ?? 0,
            oldestQueuedAgeMs: outboxState?.oldestQueuedAgeMs ?? null,
          };
          publishAggregateHealth(false);
          log.error({
            event: 'outbox_cycle_error',
            consecutiveErrors,
            backoffMs,
            classification: 'outbox_cycle_failed',
          });
          if (consecutiveErrors >= maxConsecutiveErrors) {
            throw new Error('outbox dispatcher failure threshold exceeded', {
              cause: error,
            });
          }
          await abortableSleep(backoffMs, ownerSignal);
          heartbeat.recordProgress();
        }
      }
    }

    async function runLeaseMonitor(): Promise<void> {
      if (!lease) return;
      const intervalMs = Math.min(config.pollHeartbeatMs, 30_000);
      while (!ownerSignal.aborted) {
        await abortableSleep(intervalMs, ownerSignal);
        if (ownerSignal.aborted) return;
        if (!(await lease.heartbeat())) {
          leaseLost = true;
          log.error({
            event: 'worker_lease_lost',
            classification: 'lease_session_lost',
          });
          ownerAbort.abort();
          return;
        }
        heartbeat.recordProgress();
      }
    }

    async function guardLoop(loop: () => Promise<void>): Promise<void> {
      try {
        await loop();
      } catch (error) {
        ownerAbort.abort();
        throw error;
      }
    }

    try {
      const tasks = [
        guardLoop(runSourceLoop),
        guardLoop(runDispatcherLoop),
        ...(lease ? [guardLoop(runLeaseMonitor)] : []),
      ];
      const results = await Promise.allSettled(tasks);
      ownerAbort.abort();
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure) throw failure.reason;
    } finally {
      ownerAbort.abort();
      ownerScope.dispose();
      // On an orderly handoff withdraw readiness before unlocking. If the
      // session was already lost, leave the marker alone: a new owner may have
      // acquired the lease and replaced it.
      if (!leaseLost) heartbeat.reset();
      await lease?.release();
      log.info({
        event: 'worker_lease_released',
        reason: options.signal?.aborted ? 'shutdown' : 'failover',
      });
    }

    if (!options.signal?.aborted) {
      await abortableSleep(1_000, options.signal);
    }
  }
}

export interface WorkerHeartbeat {
  /** Remove any marker left by a previous process and forget its success state. */
  reset(): void;
  /** Refresh liveness without changing the last completed-cycle health truth. */
  recordProgress(): void;
  /** Publish an unhealthy completed/failed cycle without advancing success. */
  recordUnhealthy(health?: WorkerHealthSnapshot, disabled?: boolean): void;
  /** Publish a healthy completed cycle and advance its success timestamp. */
  recordSuccess(health?: WorkerHealthSnapshot): void;
  /**
   * Publish an aggregate verdict from independent loops. A successful source
   * iteration advances source freshness even when outbox health keeps aggregate
   * readiness false; dispatcher-only updates never forge source freshness.
   */
  recordStatus(
    health: WorkerHealthSnapshot,
    options: { healthy: boolean; disabled: boolean; sourceSucceeded: boolean },
  ): void;
}

export interface WorkerHealthSnapshot {
  sourceStaleCount: number;
  outboxQueued: number;
  outboxProcessing: number;
  outboxDeadLetter: number;
  outboxOldestQueuedAgeMs: number | null;
}

/**
 * Version-2 marker written after the worker has finalized a health result.
 *
 * Before the first result, the marker intentionally contains only the legacy
 * fields plus a null success timestamp and must be treated as not ready.
 * `heartbeatAtMs` makes liveness an embedded, atomic fact instead of asking
 * readers to infer it from filesystem mtime. `healthy` is the worker's current
 * completed-cycle verdict; readers must still validate the bounded counters.
 */
export interface WorkerHeartbeatMarker {
  version: 2;
  vapidPublicKey: string | null;
  heartbeatAtMs?: number;
  lastSuccessfulCycleAtMs: number | null;
  healthy?: boolean;
  /** True when KILL_SWITCH or the durable FR-7 safety stop disables source fetching. */
  disabled?: boolean;
  health?: WorkerHealthSnapshot | null;
}

/**
 * Keep process liveness and readiness in one atomic marker without conflating
 * them. Progress preserves the last completed-cycle verdict; success and
 * failure replace it explicitly. This prevents a backoff heartbeat from
 * accidentally turning stale health green while still giving readers an
 * embedded liveness timestamp independent of filesystem mtime.
 */
export function createWorkerHeartbeat(now: () => number = Date.now): WorkerHeartbeat {
  let lastSuccessfulCycleAtMs: number | null = null;
  let lastHealth: WorkerHealthSnapshot | undefined;
  let healthy: boolean | null = null;
  let disabled: boolean | null = null;

  function recordStatus(
    health: WorkerHealthSnapshot,
    options: { healthy: boolean; disabled: boolean; sourceSucceeded: boolean },
  ): void {
    lastHealth = health;
    if (options.sourceSucceeded) lastSuccessfulCycleAtMs = now();
    healthy = options.healthy;
    disabled = options.disabled;
    writeWorkerHeartbeat(now(), lastSuccessfulCycleAtMs, healthy, disabled, lastHealth);
  }

  return {
    reset(): void {
      lastSuccessfulCycleAtMs = null;
      lastHealth = undefined;
      healthy = null;
      disabled = null;
      clearWorkerHeartbeat();
    },
    recordProgress(): void {
      writeWorkerHeartbeat(now(), lastSuccessfulCycleAtMs, healthy, disabled, lastHealth);
    },
    recordUnhealthy(health?: WorkerHealthSnapshot, sourceDisabled = false): void {
      if (health) lastHealth = health;
      healthy = false;
      disabled = sourceDisabled;
      writeWorkerHeartbeat(now(), lastSuccessfulCycleAtMs, healthy, disabled, lastHealth);
    },
    recordSuccess(health?: WorkerHealthSnapshot): void {
      if (health) lastHealth = health;
      lastSuccessfulCycleAtMs = now();
      healthy = true;
      disabled = false;
      writeWorkerHeartbeat(now(), lastSuccessfulCycleAtMs, healthy, disabled, lastHealth);
    },
    recordStatus,
  };
}

/** Write the versioned API/infra readiness record atomically. */
function writeWorkerHeartbeat(
  heartbeatAtMs: number,
  lastSuccessfulCycleAtMs: number | null,
  healthy: boolean | null,
  disabled: boolean | null,
  health?: WorkerHealthSnapshot,
): void {
  const path = process.env['WORKER_HEARTBEAT_FILE']?.trim() || '/tmp/seat-sniper-worker-heartbeat';
  const temporaryPath = `${path}.tmp`;
  const vapidPublicKey = process.env['VAPID_PUBLIC_KEY']?.trim() || null;
  const marker: WorkerHeartbeatMarker = {
    version: 2,
    vapidPublicKey,
    lastSuccessfulCycleAtMs,
    ...(healthy === null
      ? {}
      : {
          heartbeatAtMs,
          healthy,
          disabled: disabled ?? false,
          health: health ?? null,
        }),
  };
  writeFileSync(temporaryPath, `${JSON.stringify(marker)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function clearWorkerHeartbeat(): void {
  const path = process.env['WORKER_HEARTBEAT_FILE']?.trim() || '/tmp/seat-sniper-worker-heartbeat';
  for (const candidate of [path, `${path}.tmp`]) {
    try {
      unlinkSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
