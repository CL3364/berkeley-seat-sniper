# Plan 0001 — Migrate availability source to the official Berkeley SIS Class API

Status: Planned (not started)
Decision: [ADR 0002](../adr/0002-scrape-public-pages-with-api-migration-planned.md)
Read this before implementing. The goal is to replace HTML scraping with the sanctioned
API **behind the existing seam**, so only the scraper lane changes.

## Goal

Make the availability source the official Berkeley SIS **Class API** (structured,
sanctioned) instead of scraping `classes.berkeley.edu` HTML, while keeping
`fetchClass(classKey) → ParseResult` as the only thing the worker/notifier/UI know about.

## Why

ADR 0002: scraping is brittle (HTML changes → parser-broke), block-prone, and ToS-grey.
The API is stable and authorized. The `ParseResult` seam makes this a scraper-lane-only
change.

## Pre-work (blocking)

1. **Register for API access** at the Berkeley API Central developer portal; obtain an
   `app_id` + `app_key` for the **SIS Class API** (and the **Class Sections API** if
   per-section availability lives there). Confirm the plan/quota and rate limits.
2. **Confirm the API exposes live seat counts** — `enrolledCount`, `maxEnroll`,
   `waitlistCount`, `waitlistMax`, reserved-seat breakdown, open/closed status. If it only
   exposes catalog data (not live availability), this migration does NOT replace the
   scraper for the open-seat signal — stop and re-evaluate.
3. Map the API's identifiers to our canonical `ClassKey` (term / subject / course /
   section / component). The API keys on `term id` + `class/section number`; write the
   `ClassKey ⇄ API params` mapping.

## Contract / shared

- **No change** to `ParseResult`, `SeatState`, `ClassKey` if the API yields the same
  fields. If the API gives a richer reserved-vs-general seat breakdown we decide to use,
  the architect versions `SeatState` first (see open question below).

## Lane changes (scraper lane only — `src/scraper/**`)

- Add `src/scraper/sources/sisApi.ts`: `fetchClassViaApi(classKey, opts)` that calls the
  API with `app_id`/`app_key` from env, maps the JSON response to `SeatState`
  (status from open seats + waitlist), or returns `parser-broke` on a shape it can't read.
- Keep `parseClassPage` / the HTML path as a **fallback** behind a `SOURCE` env switch
  (`api` | `scrape`), so we can flip back if the API has an outage.
- `fetchClass` becomes a thin dispatcher on `process.env.AVAILABILITY_SOURCE` (default
  `api` once validated). Same signature — worker/notifier/UI untouched.
- Secrets: `SIS_APP_ID`, `SIS_APP_KEY` from env only (constitution). Add to `env.example`
  (names only). Update the security-gate expectations (a key now ships in prod config).
- Respect the API's rate limits with the existing jitter/backoff; the one-fetch-per-unique-
  Section rule still holds and matters less (no IP-block risk, but quota does).

## Tests (`tests/**`, owned by test-engineer)

- Saved JSON fixtures (success: open / closed / waitlist; and a malformed/changed-shape
  payload → parser-broke), mirroring the existing HTML fixtures.
- A `fetchClassViaApi` unit suite injecting a fake `fetchImpl` (no network), asserting the
  same `ParseResult` invariants (FR-6: never coerce a parse miss to 0 seats).
- Kill-switch + missing-key behavior (fail loud, do not silently fall back to 0 seats).

## Acceptance

- With `AVAILABILITY_SOURCE=api`, the worker's transition/dedupe/parser-broke behavior
  (AC-3..AC-6) is unchanged when driven by API fixtures.
- Robots/ToS launch gate from ADR 0002 is no longer the blocker (API is sanctioned).
- No secret in logs; `npm audit --omit=dev` still clean.

## Open questions

- Does the API distinguish **reserved** seats (major-restricted) from general seats? If
  so, an "available seat" that the student can't actually take is false hope — we may want
  `SeatState` to carry a `generalOpenSeats` vs `reservedOpenSeats` split (architect change,
  ties to a future "reserved seats" grill branch).
- Polling vs webhook: the API is poll-only today; cadence decision (ADR-less, ~30s) carries
  over but is now bounded by API quota, not politeness.

## Sequence

1. Register + validate live-availability fields (blocking).
2. Architect: confirm whether `SeatState` needs the reserved/general split; version if so.
3. scraper: add `sisApi.ts` + the `AVAILABILITY_SOURCE` dispatcher; keep HTML fallback.
4. test: API fixtures + suite.
5. devops: provision `SIS_APP_ID`/`SIS_APP_KEY` in prod; flip the default to `api`.
6. Retire the scraper path once the API is proven in production for one enrollment cycle.
