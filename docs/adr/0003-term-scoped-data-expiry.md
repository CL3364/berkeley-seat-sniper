# 3. Term-scoped expiry of Watches and Subscribers

Date: 2026-06-05
Status: Accepted

## Context

A Watch is inherently time-bounded: its Section belongs to exactly one Term (the Term is
encoded in the Section's identity), and once that Term's Enrollment window closes, the
Opening the Watch waits for can never occur again. Left in place, an expired Watch causes
two problems:

- The poller keeps fetching a Section whose page may have been removed, producing
  perpetual parser-broke Operator alerts and wasted upstream requests.
- The system keeps holding a student's email + watch list with no remaining purpose,
  violating the constitution's "keep the PII surface tiny by design" principle.

The domain is seasonal, so retention should follow the Term, not the clock.

## Decision

Retention is **term-scoped**:

- Each Watch is tied to its Section's Term. When that Term's Enrollment window closes, the
  Watch is **retired**: it is no longer polled and triggers no Alerts.
- A Subscriber left with **no live Watches** is purged (email + rows deleted).
- A **Pending Subscriber** (never confirmed — see ADR 0001) is purged after a short fixed
  window (e.g. N days) even if the Term is still open.

## Consequences

- **+** PII is held only as long as there is a live reason to, automatically.
- **+** The poller never grinds on dead Sections; parser-broke noise from ended Terms
  disappears.
- **+** Matches the seasonal reality of enrollment; no arbitrary global clock.
- **−** Requires knowing each Term's Enrollment-window-close date (configuration or a
  small per-Term calendar) — the system must learn "this Term is over."
- **−** Deletion is irreversible: a returning student starts fresh next Term. Acceptable,
  and arguably desirable, for a no-account product.
- **Surprise to manage:** a Subscriber may wonder why their watches "disappeared" between
  Terms. The manage UI / a final email should explain that Watches end with the Term.

## Alternatives considered

- _Manual-only lifecycle_ — data lives until the Subscriber acts; operators purge by hand.
  Rejected: unbounded stale data, dead-Section polling, and a growing PII pile.
- _Global TTL (N days from creation)_ — simple and bounded, but arbitrary: it can expire a
  still-valid Watch mid-Term or retain a dead one when a Term is short.
