# 6. v1 is reserved-seat-blind; reservation-aware alerting is deferred

Date: 2026-06-05
Status: Accepted

## Context

Berkeley Sections can hold **Reserved Seats** for one or more **Reservation Groups**
(major, class standing / terms completed, first-years, transfers, …). Researched behavior:

- If you are not in the Reservation Group, you cannot take the seat even when it shows
  open. (sis.berkeley.edu — Reserved Seats; registrar glossary)
- "Reserved seats may stay reserved for the entire semester or they may open up" — it
  **varies by course**. Many departments (e.g. EECS/CS) **release reserved seats on the
  first day of instruction**, when the waitlist/general pool fills them.
- While a reservation is active, a freed Reserved Seat returns to **that group's pool**
  (it does not become General) until the reservation's release date.

The shipped v1 parser reads a single `available` count
(`.enroll-numbers .available .count`) with **no general-vs-reserved breakdown**, and the
product has **no login**, so it cannot know a Subscriber's eligibility.

## Amendment (2026-08-22) — the premise below is FACTUALLY WRONG

**Corrected by a live capture, not by argument.** The Context section states the parser "reads a
single `available` count ... with **no general-vs-reserved breakdown**", and the Decision defers
reservation-aware work to Plan 0006 as "dependent on a structured source (Plan 0001, the SIS API)".

Both rest on the belief that the public page does not publish the breakdown. **It does**, twice
over, and `src/scraper/fixtures/live-compsci-189-2026-08-21.html` is the proof:

- visible, inside the very `section.current-enrollment` the parser already scopes to:
  `Open Reserved Seats: 41 reserved for Students with Enrollment Permission`
- embedded JSON: `"openReserved": 41` plus a per-group `seatReservations` array carrying
  `requirementGroup`, `maxEnroll`, and `enrolledCount`.

That page reported `Total Open Seats: 41` and `Open Reserved Seats: 41` — **every open seat was
reserved**. A live poller would have alerted every Subscriber watching COMPSCI 189 that 41 seats
opened, and none of them could enrol. The risk this ADR accepted as theoretical was live on the
first real page the project ever fetched.

**What this unblocks, and what it does not.** It supplies the general-vs-reserved COUNT, so the
product can be honest about what kind of seat opened. It does NOT supply ELIGIBILITY — there is
still no login, so the system cannot know whether a given Subscriber belongs to a Reservation
Group. This ADR conflates the two; only the second genuinely needs a structured identity source.
Plan 0006's "Blocked pending a new data-source/product design" status therefore applies to the
eligibility half only.

**Owner ruling 2026-08-22 — alert regardless.** An Alert fires on any seat opening, reserved or
not. A reserved seat is genuinely available to whoever holds the permission, and suppressing it
would cost those students the notification while FR-5 dedupe might withhold the next one. What
changes is honesty rather than the trigger: `openReserved` is now an observation (FR-27) and both
the dashboard box and the Alert body must say when open seats are reserved. Display-only — never
filter, rank, or suppress on it.

## Decision

For v1, treat **every open seat alike** — a Seat Opening fires on the single available
count, regardless of whether the seat is General or Reserved. Document the reserved-seat
caveat as a known limitation. **Reservation-aware alerting** (parse the per-group
breakdown; let a Subscriber declare which Reservation Groups they belong to; only Alert on
seats they're eligible for) is **deferred to Plan 0006**, dependent on a structured source
(Plan 0001, the SIS API).

## Consequences

- **+** v1 ships without a major cross-lane feature or a dependency on a reliable
  reserved-seat data source it doesn't have.
- **−** False positives: a Subscriber can be Alerted for a Reserved Seat they cannot take.
  Mitigate with honest Alert copy ("a seat opened — note some seats are reserved for
  specific groups").
- The eligibility feature is genuinely warranted (research confirms freed reserved seats
  stay reserved), so it is planned, not dismissed — see Plan 0006.

## Why not build it now

- Needs the per-group reserved breakdown, which the v1 scraper (single number, synthetic
  fixtures) does not provide; the SIS API (Plan 0001) is the clean source.
- Reservation-release semantics vary per course (some release day 1, some hold all term),
  so the feature must model release dates — deliberate design, not a quick patch.
- It is a contract + schema + UI + scraper + worker change; it should follow Plan 0001.

## Sources

- https://sis.berkeley.edu/help/enrollment-faq/reserved-seats
- https://registrar.berkeley.edu/enrollment/glossary/
- https://inst.eecs.berkeley.edu/~cs188/sp26/fa26-faqs/ (example: reserved seating ends day 1)
