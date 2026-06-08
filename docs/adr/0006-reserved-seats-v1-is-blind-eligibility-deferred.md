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
