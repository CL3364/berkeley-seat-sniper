# Plan 0009 — Operator alerting + parser-broke runbook

Status: Repository implementation complete; production inbox and incident drill remain open.
Owner decision 2026-06-09: destination is a MONITORED EMAIL INBOX
(`OPERATOR_EMAIL`, set at deploy time; chat webhook not built for launch); the
class-gone/shape-changed split IS in scope this pass (not a fast-follow); debounce +
fail-loud `OPERATOR_EMAIL` requirement in scope as planned.
Decision: grill launch-Q2 + [ADR 0009](../adr/0009-launch-posture-closed-pilot-then-public.md)

## Goal

Guarantee that a scraper break reaches a MONITORED human quickly, without fatiguing them,
and give that human a runbook. The constitution says the parser WILL break; if a break goes
unnoticed, the pilot silently stops delivering Alerts while users miss seats.

## Historical gaps (resolved by the v0.4 repository implementation)

- `notifier.alertOperator(classKey, detail)` sends to `OPERATOR_EMAIL ?? MAIL_FROM` — if
  `OPERATOR_EMAIL` is unset it silently falls back to the no-reply `from`, so breaks can go
  unseen. `OPERATOR_EMAIL` is now documented in `env.example` (this change), but the app
  does not yet REQUIRE/validate it.
- The worker calls `alertOperator` EVERY poll cycle a class is broken → a single persistent
  break emails the operator every interval → fatigue → muted → silent failure.
- `fetchClass` returns `parser-broke` for BOTH a removed page (404, section gone) and a
  200 page whose shape changed (parser needs fixing) — different problems, same signal.

## Changes

### notify lane (`src/notify`)

- Treat `OPERATOR_EMAIL` as REQUIRED for a non-noop transport: warn loudly at startup (or
  refuse to start) if unset, instead of silently using `MAIL_FROM`.
- Support a chat-webhook operator channel (Slack/Discord) as an alternative to email
  (operators watch chat more reliably than a shared inbox). Behind env.

### worker lane (`src/worker`)

- Debounce operator alerts: alert ONCE per broken-class episode. Track the last operator
  alert per `classKey` (in `class_state` or a small map) and re-alert only after the class
  recovers (a successful parse) or after a long cooldown (e.g. 6h), not every cycle.
- Emit a recovery log/alert when a previously-broken class parses cleanly again.

### scraper lane (`src/scraper`)

- Distinguish **page-gone** from **shape-changed**: if the fetch is a 404 (or the page is a
  known "class not found" page), return a distinct signal (e.g. `kind:'class-gone'`) vs the
  `parser-broke` (200-but-unparseable) signal. The worker then:
  - **class-gone** → retire the Watch (it's a cancelled/term-ended Section; ties to
    ADR 0003 / Plan 0004 term expiry) and optionally notify the Subscriber it's no longer
    watchable — NOT an operator alert (it's expected, not a bug).
  - **parser-broke (shape changed)** → operator alert (the parser needs fixing).

## Runbook (docs — write alongside the code)

On a parser-broke operator alert:

1. Open `https://classes.berkeley.edu/content/<classKey>` in a browser.
2. **404 / "class not found"** → the Section was cancelled or the term ended. Retire the
   Watch (or let the term-expiry sweep handle it). Not a code bug.
3. **200 but the labeled enrollment fields moved/renamed** → keep the source halted if
   continued polling is unsafe, update `src/scraper/parse.ts` against sanitized
   live-shaped fixtures, run the gates, and ship. The SIS API is not a student-accessible
   fallback (ADR 0002).
4. If the upstream is rate-limiting/blocking us → set `KILL_SWITCH=1` to halt fetching,
   then back off / contact the registrar.

## Tests

- Operator alert fires once per broken-class episode, not every cycle; a recovery resets it.
- A 404/class-gone retires the Watch and does NOT page the operator.
- A shape-changed (200) fixture pages the operator exactly once.

## Pilot minimum

- `OPERATOR_EMAIL` set to a monitored inbox/channel + fail-loud if unset.
- Operator-alert debounce (no per-cycle spam).
- Class-gone/shape-changed split + retirement.
- Exercise the parser-broke, kill-switch, recovery, and monitored-inbox path before pilot.
