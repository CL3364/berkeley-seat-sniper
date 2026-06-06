# 2. Scrape public class pages for v1; official API is the planned foundation

Date: 2026-06-05
Status: Accepted

## Context

Availability data has two possible sources:

- **The public class pages** at `classes.berkeley.edu/content/<section>` — keyless,
  publicly visible, but unstructured HTML. The constitution already concedes the parser
  "WILL break when the upstream HTML changes," and scraping carries IP-block risk and a
  terms-of-service grey area.
- **The official Berkeley SIS Class API** — sanctioned and structured, but requires app
  registration + a managed key and imposes its own rate limits.

v1 is already built on the scraper, and the system is cleanly layered: the worker,
notifier, and UI depend only on `fetchClass(section) → ParseResult`. The data source sits
entirely behind that seam, so it can be swapped without touching the monitor core.

## Decision

Launch v1 on the existing scraper, and treat the official SIS Class API as the planned
foundation to migrate to behind the `fetchClass → ParseResult` seam. Two conditions bind
the scraping launch:

1. **Robots/ToS validation is a hard pre-launch gate.** Confirm `robots.txt` permits the
   `content/` path and that the terms permit automated, polite, read-only access before
   any real traffic.
2. **Politeness is non-negotiable** while scraping: one fetch per unique Section per
   interval, identifying User-Agent, jittered/backed-off cadence, and the kill-switch.

## Consequences

- **+** Ships now with no external dependency, registration, or secret to manage.
- **+** The `ParseResult` seam means the eventual API migration is a scraper-lane change
  only; the worker/notifier/UI are unaffected.
- **−** Carries ongoing HTML brittleness (mitigated by saved-fixture tests + the
  parser-broke Operator alert) and IP-block / ToS exposure.
- **−** "Scraping works today" can quietly become "scraping is the permanent foundation"
  if the migration is never scheduled. This ADR exists partly to prevent that drift.
- **Launch gate:** if robots/ToS disallows scraping the content path, v1 cannot launch on
  the scraper and the API migration becomes a blocker, not a follow-up.

## Alternatives considered

- *Re-architect onto the official API now* — more robust and ToS-clean from day one, but
  re-does the working scraper lane and adds registration + a managed key before launch.
  Deferred, not rejected: it is the intended end state.
- *Commit to scraping permanently* — rejected; it treats a known-brittle, block-prone,
  grey-area source as load-bearing forever.
