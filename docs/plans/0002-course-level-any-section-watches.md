# Plan 0002 — Course-level "any section" Watches

Status: Planned (not started)
Decision: [ADR 0004](../adr/0004-watch-is-atomic-at-the-section.md)
Read this before implementing. v1 keeps Watch = Section; this adds a Course Watch on top
without breaking the Section model.

## Goal

Let a Subscriber watch a whole **Course** ("CS 189, any section") and be Alerted once when
**any** of its Sections has a Seat Opening — instead of adding every Section by hand and
getting one Alert per Section.

## Domain language (update CONTEXT.md when built)

- **Course** — a term-scoped course (e.g. `2026-fall-compsci-189`), the parent of one or
  more Sections. New glossary term.
- **Course Watch** — a Subscriber's standing interest in a Course: "Alert me when any of
  this Course's Sections has a Seat Opening." Distinct from a (Section) Watch.
- The atomic Watch stays as-is; a Course Watch is a second, higher-grain watch type.

## Key design decisions to make first

1. **Section enumeration.** A Course Watch must know the Course's current Sections.
   Source: the SIS API (preferred, see Plan 0001) or a scrape of the course page.
   Sections change during enrollment (added/cancelled), so enumeration must refresh each
   cycle — a Course Watch is "watch the current section set, which may drift."
2. **Notify-once semantics.** When any Section opens, Alert once and then... stop? or keep
   alerting on further sections? Recommended: Alert on the **first** Seat Opening across
   the Course, then mark the Course Watch **satisfied** (no more Alerts) until the
   Subscriber re-arms or removes it — matches "I just need in once." Make this explicit;
   it is the whole value over N Section Watches.
3. **Dedupe scope.** Idempotency key moves from `(subscriberId, classKey, openedAt)` to
   `(subscriberId, courseKey, openedAt-of-first-section)`; otherwise two sections opening
   in the same cycle double-Alert.

## Contract / shared (architect versions `src/shared`)

- Add `CourseKey` (brand) + `normalizeCourseKey` (drop the section/component slots from a
  ClassKey or accept a course URL/code).
- Add `CourseWatch` type and a `reason: 'course-seats-open'` Alert variant carrying which
  Section actually opened (`openedSection: ClassKey`).
- New endpoints (mirror the Section watch routes): `POST /api/subscriptions/:token/course-watches`,
  `DELETE .../course-watches/:courseKey`. `GET` returns both Watches and Course Watches.

## Schema (db lane)

- `course_watches(id, subscriber_id FK, course_key, satisfied bool default false,
created_at)`, unique `(subscriber_id, course_key)`, index `(course_key)`.
- `course_sections(course_key, class_key, term, last_seen_at)` — the enumerated section set
  per Course, refreshed by the worker; index `(course_key)`.
- Term-scoped expiry (ADR 0003 / Plan 0004) applies to Course Watches too.

## Worker lane

- Each cycle: for every distinct watched Course, enumerate its current Sections (API/scrape),
  upsert `course_sections`, fetch each unique Section once (already deduped with Section
  Watches — never double-fetch a Section watched both ways), and on the first Seat Opening
  across the Course's sections, fan out a `course-seats-open` Alert to that Course's
  Subscribers and set `satisfied = true`.
- Respect "one fetch per unique Section per interval" globally across both watch types.

## UI lane

- Subscribe/manage: a "watch the whole course (any section)" toggle next to a Section add;
  show Course Watches and their satisfied/armed state; a "re-arm" action.

## Tests

- AC: a Course with sections all full → no Alert; one section opens → exactly one
  `course-seats-open` Alert naming that section; a second section opening same Course →
  no new Alert while satisfied; re-arm → eligible again.
- A Section watched both directly and via its Course is fetched once per cycle.

## Risks / notes

- Enumeration drift: a section cancelled mid-term should drop out of the set cleanly
  (ties to the "dead Section" grill branch, not yet decided).
- This is the most likely first post-v1 feature; do it **after** Plan 0001 (API) so section
  enumeration is reliable rather than another scrape.
