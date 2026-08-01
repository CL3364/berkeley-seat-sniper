# Plan 0006 — Reservation-aware alerting + Subscriber eligibility

Status: Blocked pending a new data-source/product design; do not assume Plan 0001 access
Decision: [ADR 0006](../adr/0006-reserved-seats-v1-is-blind-eligibility-deferred.md)

## Goal

Stop Alerting Subscribers about Reserved Seats they can't take. Parse the per-group
reserved-seat breakdown, let a Subscriber declare which Reservation Groups they belong to,
and only fire a Seat Opening Alert for seats that Subscriber is eligible for (General
seats, or Reserved seats in a group they're in).

## Research basis (see ADR 0006)

- A freed Reserved Seat generally returns to its Reservation Group's pool, not to General,
  until the reservation's release date — so eligibility matters, and a per-group signal is
  required, not just a total.
- Reservations release on a per-course date (often day 1 of instruction); after release,
  those seats are General. The model must track "is this reservation still active?"

## Prerequisite

- A source that exposes the per-group reserved breakdown + release date. The SIS Class API
  (Plan 0001) is the intended source; raw HTML scraping of reserved blocks is brittle and
  may not expose release dates. **Do not start this before Plan 0001 is validated.**

## Domain language (add to CONTEXT.md when built)

- General Seat, Reserved Seat, Reservation Group are already in the glossary (added with
  ADR 0006). Add **Eligibility** — the set of Reservation Groups a Subscriber declares
  membership in (self-asserted; unverifiable without login).

## Contract / shared (architect versions `src/shared`)

- Extend `SeatState`: replace the single `openSeats` with a breakdown, e.g.
  `generalOpenSeats: number` + `reservedOpen: Array<{ group: ReservationGroupId; seats: number; releasesAt?: string }>`.
  Keep a derived `openSeats` total for backward-compat / the reserved-blind path.
- Add `ReservationGroupId` + a small catalog of known groups (or treat as opaque strings
  the API returns).
- `Watch` (or `Subscriber`) gains a self-asserted `eligibleGroups: ReservationGroupId[]`.
- Alert reason stays `seats-open`, but the worker only counts a seat toward an Opening for
  a given Subscriber if it is General or in the Subscriber's `eligibleGroups`.

## Schema (db lane)

- `subscriber_eligibility(subscriber_id, group_id)` (or an array column), since eligibility
  is per-person, not per-watch. Decide: per-Subscriber (simpler) vs per-Watch (a student
  may be major-eligible for one course but not another — likely per-Subscriber by
  standing, per-Course-major for major reservations; start per-Subscriber).
- `class_state` may need to store the per-group last-availability to detect a _group-level_
  0→>0 transition (a general 0→>0 vs a reserved-group 0→>0 are different Openings).

## Worker lane

- Transition detection becomes per-eligible-pool: for each Subscriber, compute the seats
  they're eligible for (general + their groups) and detect 0→>0 on _that_ number, so two
  Subscribers watching the same Section can legitimately get different Alert outcomes.
- Respect reservation release dates: once a reservation releases, its seats fold into
  General for everyone.
- Still one fetch per unique Section; the per-Subscriber computation is in-memory.

## UI lane

- Onboarding / manage: "Which of these apply to you?" — class standing (terms completed),
  major(s), first-year/transfer — to populate `eligibleGroups`. Make clear it's
  self-reported and only filters Alerts (no verification).

## Tests

- A Section with only reserved-for-CS-majors open seats → a CS-major Subscriber is Alerted;
  a non-CS Subscriber is not.
- After the reservation release date, the same seats Alert everyone (now General).
- General 0→>0 Alerts everyone eligible; per-group transitions don't leak across groups.

## Risks / notes

- Eligibility is self-asserted (no login) — it filters false positives but a user can lie
  to themselves; that's acceptable (it only affects their own Alerts).
- If the API doesn't expose release dates, approximate with a per-course config or treat
  reserved as reserved until proven General. Document the approximation.
