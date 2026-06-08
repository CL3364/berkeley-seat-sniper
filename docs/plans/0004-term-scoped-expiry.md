# Plan 0004 — Term-scoped expiry of Watches and Subscribers

Status: Planned (not started)
Decision: [ADR 0003](../adr/0003-term-scoped-data-expiry.md)

## Goal

Retire Watches when their Term's Enrollment window closes; purge Subscribers with no live
Watches; purge Pending Subscribers after N days.

## Needs first: a notion of "Term is over"

- A small per-Term config/calendar: `TERM_ENROLLMENT_CLOSE` dates, keyed by the term slug
  already inside every `ClassKey` (`2026-fall-...`). Source it from config (simplest) or
  the SIS API term calendar (Plan 0001).
- A helper `isTermOpen(term, now)` shared where the worker and the sweep can both use it
  (lives in scraper or a small shared util — architect decides; it is policy, not a schema
  thing).

## Worker lane

- Before fetching, skip (and mark retired) any Watch whose Term is closed — the poller
  never fetches a dead Section. `getDistinctWatchedClassKeys` filters to live Terms.

## Sweep (new small job — worker lane or a scheduled task)

- Periodically (daily): retire Watches in closed Terms; delete Subscribers left with zero
  live Watches; delete Pending Subscribers (`confirmed_at is null`) older than
  `PENDING_TTL_DAYS` (default e.g. 7).
- All deletes cascade (watches FK `on delete cascade` already exists).

## Schema (db lane)

- Optional `watches.retired_at` if we prefer soft-retire over hard delete for an audit
  window; otherwise hard-delete on sweep. Recommended: hard delete (tiny-PII principle).
- A query for "subscribers with no live watches" + "pending older than N days".

## UI / notifier

- Optional end-of-term email: "your watches for Fall 2026 have ended." Nice-to-have.
- Manage view explains watches end with the Term (prevents the "where did my watches go?"
  surprise called out in ADR 0003).

## Tests

- A Watch in a closed Term is not polled and triggers no Alert.
- The sweep deletes a Subscriber with only closed-Term Watches; keeps one with a live Watch.
- A Pending Subscriber older than N days is purged; a fresh Pending one is kept.

## Risks

- Getting Term-close dates wrong retires watches early or late — config must be reviewed
  each Term. Prefer the API term calendar once Plan 0001 lands.
