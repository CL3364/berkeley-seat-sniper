/**
 * src/worker/operator-debounce.ts
 *
 * Operator-alert debounce for the worker lane (B4 / D7 / FR-14 / AC-15).
 *
 * THE PROBLEM
 *   `parser-broke` is, by design, a LOUD signal — the constitution says the
 *   parser WILL break. But the poller revisits every broken class once per poll
 *   interval (30s default). Without debounce a single persistent break pages the
 *   operator every cycle until the operator mutes the alert — at which point a
 *   genuinely new break goes unseen. We want exactly ONE operator alert per
 *   broken EPISODE and a logged recovery when the class parses cleanly again.
 *
 * EPISODE MODEL (per debounce key)
 *   - A key is in one of two states: not-in-episode, or in-episode.
 *   - First broken observation for a key OPENS an episode and returns
 *     `shouldAlert: true` (the one alert per episode).
 *   - Subsequent broken observations within the same episode return
 *     `shouldAlert: false`, regardless of elapsed time.
 *   - A clean parse of that key RECOVERS the episode (clears the state) and the
 *     caller logs `operator_episode_recovered`. The next break opens a fresh
 *     episode and alerts again.
 *
 * DEBOUNCE KEY (robots-episode collapse — lead requirement)
 *   parser-broke results whose `detail` starts with `robots.txt:` are NOT a
 *   per-class parser bug — they are a single HOST-LEVEL condition (RFC 9309:
 *   robots.txt 5xx/unreachable → skip the whole cycle). A robots outage spread
 *   across 40 watched classes must page the operator ONCE, not 40 times. So all
 *   robots-skip results collapse onto a single synthetic key (`ROBOTS_EPISODE_KEY`)
 *   regardless of classKey; genuine per-class parser breaks key on the classKey.
 *   The robots episode recovers when ANY class fetch succeeds again (the worker
 *   calls `recover()` on every successful SeatState parse, including for the
 *   robots key).
 *
 * LEGACY HARNESS ONLY
 *   This in-memory helper remains for the deterministic v0.3 harness. The v0.4.2
 *   production path persists episode state in `parser_health`, so restart and
 *   lease failover cannot re-arm a still-broken Section.
 *
 * PII: this module stores only debounce keys (classKey or the synthetic robots
 * key) and timestamps — never a subscriber email or watch list (AC-8).
 *
 * Lane: src/worker/** — owned by worker-engineer.
 */

import type { ClassKey } from '../shared/class-key';

/**
 * Synthetic debounce key all robots-skip parser-broke results collapse onto, so
 * a host-level robots outage pages the operator ONCE per episode rather than
 * once per affected class. Not a real ClassKey (the leading char is illegal in a
 * canonical key) so it can never collide with a genuine per-class episode.
 */
export const ROBOTS_EPISODE_KEY = '__robots__';

/** The decision returned by {@link OperatorAlertDebouncer.observeBroken}. */
export interface DebounceDecision {
  /** True iff the caller should actually page the operator this cycle. */
  shouldAlert: boolean;
  /**
   * Why the alert fires (or not) — for the structured log line, never PII.
   *   'episode-open' first break of a new episode → alert
   *   'debounced'    episode remains broken → suppress
   */
  reason: 'episode-open' | 'debounced';
}

/**
 * Tracks operator-alert episodes across poll cycles. Construct ONCE
 * (`startPoller` does; tests that span multiple cycles inject one shared
 * instance) so episode state survives between `runPollCycle` calls.
 */
export interface OperatorAlertDebouncer {
  /**
   * Record a broken observation for a class and decide whether to alert.
   * `kind` distinguishes a genuine per-class parser break from a host-level
   * robots skip (the latter collapses onto {@link ROBOTS_EPISODE_KEY}).
   */
  observeBroken(classKey: ClassKey, kind: 'parser-broke' | 'robots'): DebounceDecision;

  /**
   * Roll back the reservation made by an alerting decision when delivery
   * fails. The next cycle retries instead of silently suppressing an alert
   * that never reached the operator.
   */
  alertFailed(
    classKey: ClassKey,
    kind: 'parser-broke' | 'robots',
    reason: Extract<DebounceDecision['reason'], 'episode-open'>,
  ): void;

  /**
   * Record a successful parse for a class. Closes only that class's parser
   * episode. The poller closes a robots episode after an entire cycle has no
   * robots-policy skips; one allowed path cannot recover another denied path.
   */
  recover(classKey: ClassKey): string[];

  /** Close only the host-level robots episode after any non-robots response. */
  recoverRobots(): string[];
}

/**
 * Build an {@link OperatorAlertDebouncer}.
 *
 * The optional fields remain accepted for source compatibility with older
 * deterministic harnesses, but are intentionally ignored. v0.4.2 forbids
 * elapsed-time re-alerting; production durability lives in `parser_health`.
 */
export function createOperatorAlertDebouncer(_opts?: {
  nowMs?: () => number;
  cooldownMs?: number;
}): OperatorAlertDebouncer {
  // The single source of truth for episode state. Keyed on classKey for genuine
  // parser breaks, or on ROBOTS_EPISODE_KEY for the collapsed robots episode.
  const episodes = new Set<string>();

  function observeBroken(classKey: ClassKey, kind: 'parser-broke' | 'robots'): DebounceDecision {
    const key = kind === 'robots' ? ROBOTS_EPISODE_KEY : classKey;
    if (!episodes.has(key)) {
      // No open episode → this is the first break. Open it and alert once.
      episodes.add(key);
      return { shouldAlert: true, reason: 'episode-open' };
    }

    // An open episode never re-alerts due to elapsed time.
    return { shouldAlert: false, reason: 'debounced' };
  }

  function alertFailed(
    classKey: ClassKey,
    kind: 'parser-broke' | 'robots',
    _reason: 'episode-open',
  ): void {
    const key = kind === 'robots' ? ROBOTS_EPISODE_KEY : classKey;
    episodes.delete(key);
  }

  function recoverRobots(): string[] {
    return episodes.delete(ROBOTS_EPISODE_KEY) ? [ROBOTS_EPISODE_KEY] : [];
  }

  function recover(classKey: ClassKey): string[] {
    const recovered: string[] = [];
    // A clean parse of THIS class closes its own per-class episode...
    if (episodes.delete(classKey)) {
      recovered.push(classKey);
    }
    return recovered;
  }

  return { observeBroken, alertFailed, recover, recoverRobots };
}
