# Spec: Berkeley Seat Sniper (notify-only)

> Living spec — the architect owns and versions this. When reality diverges, update this
> first, then let code follow. The API contract in `src/shared/**` is authoritative; this
> file summarizes it.
>
> Rev 2026-05-31 (v0.1): initial bound spec for the seat-sniper engine instance.
> Rev 2026-06-04 (v0.2): API contract authored in `src/shared/**` (class-key, seat-state,
> errors, api); §4/§5/§7/§8/§9 reconciled to it.

## 1. Problem & users

Berkeley students want a maxed-out class. When an enrolled student drops, the seat does
NOT cascade down the waitlist — it sits open as first-come-first-serve (same when a
waitlist slot frees). Students who learn of the opening first win it. **Users:** Berkeley
students (launching to a student group). **Now:** enrollment churn is highest near the
term; speed of notification is the whole value.

## 2. Scope

- **In scope (v1):** watch the PUBLIC class pages (e.g.
  `classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001`), detect the open-seat
  transition, and alert subscribers fast. Multi-user. A subscriber signs up with an email
  - a list of class URLs/codes. A thin web dashboard to manage watches. Email alerts
    (no password) baseline; optional web push.
- **Explicit non-goals (v1):** NO credentials, NO CalNet, NO auto-enroll — the system must
  never need or store a student's login. No accounts/passwords. No SMS. A Discord bot is a
  documented swap, not the default. No scraping behind auth. No reselling/queuing of seats.

## 3. Functional requirements (numbered, testable)

- FR-1: A visitor can subscribe with an email + ≥1 class URL/code; the email is validated
  and the class identifier is normalized to a canonical class key.
- FR-2: A subscriber can list, add, and remove watches, and unsubscribe entirely, via a
  link that needs no password (signed, expiring token).
- FR-3: ONE poller fetches each UNIQUE watched class at most once per interval and fans out
  to all subscribers of that class. Never one fetch per subscriber.
- FR-4: When a class transitions from 0 → >0 open seats (or a waitlist slot frees per the
  page), each subscriber of that class is notified exactly once per genuine opening.
- FR-5: A flapping seat (0→1→0→1) does not re-notify until it has closed and re-opened.
- FR-6: If the parser can no longer read the page, the system emits a distinct operator
  "parser-broke" alert and does NOT emit false "0 seats" or false openings.
- FR-7: Cadence (`POLL_INTERVAL`), jitter, backoff, identifying `User-Agent`, and a global
  kill-switch are configurable via environment; robots.txt is respected.
- FR-8: A no-op mail transport (`MAIL_TRANSPORT=noop`) delivers to an outbox log so the
  whole pipeline is verifiable without sending real mail.

## 4. API contract (summary; `src/shared/**` is authoritative)

Request bodies accept a class identifier as a URL **or** a code; both normalize to a
canonical `ClassKey` at the boundary (FR-1). Error responses are the envelope
`{ error: ApiError }` (never a bare body); auth is the signed/expiring per-subscriber
`token` in the path — a bad/expired token → `token_invalid` (401), a valid token for a
missing subscriber → `not_found` (404).

- `POST /api/subscriptions` `{ email, classKeys: string[] (1–50) }` →
  `201 { subscriberId, token, watches: ClassKey[] }` | `400 validation_error` |
  `409 conflict` | `429 rate_limited`
  - Duplicate email on create → `409 conflict`. The system never merges into, nor issues a
    manage token for, a pre-existing subscription via an unauthenticated create (prevents
    account-takeover by email enumeration). Existing subscribers manage via the token they
    already hold; a resend-link flow is out of scope for v1.
- `GET  /api/subscriptions/:token` → `200 { email, watches: ClassKey[] }` |
  `401 token_invalid` | `404 not_found`
- `POST /api/subscriptions/:token/watches` `{ classKey }` →
  `200 { watches: ClassKey[] }` | `400 validation_error` | `401 token_invalid` |
  `404 not_found` | `409 conflict`
- `DELETE /api/subscriptions/:token/watches/:classKey` (`:classKey` is canonical) →
  `204` | `401 token_invalid` | `404 not_found`
- `DELETE /api/subscriptions/:token` (unsubscribe) → `204` | `401 token_invalid` |
  `404 not_found`
- Shared types (`src/shared/`): `ClassKey` (branded) + `normalizeClassKey` (`class-key.ts`);
  `SeatState { classKey, status, openSeats, waitlistOpen, fetchedAt }`,
  `ParseResult = SeatState | { kind: 'parser-broke', classKey, detail }`, `NotifyEvent`,
  `Subscriber` (`seat-state.ts`); `ApiError { code, message, fields? }` with a fixed `code`
  union, wrapped in `{ error }` (`errors.ts`); per-endpoint request/response/param schemas +
  `API_ROUTES` table (`api.ts`). No internals leaked.

## 5. Data model (database-engineer; reconcile with §4 and `src/shared/`)

Every `class_key` column stores the canonical `ClassKey` from `src/shared/class-key.ts`
(validate with `ClassKeySchema` on the way in). `class_state` mirrors `SeatState`.

- `subscribers(id, email UNIQUE, created_at)` — `email` is PII; `id` is the opaque id
  exposed as `subscriberId`. The signed manage `token` is derived from `id` (not stored as
  plaintext); expiry is enforced at verification, per FR-2.
- `watches(id, subscriber_id FK, class_key, created_at)` — index `(class_key)` for fan-out,
  unique `(subscriber_id, class_key)` (a duplicate add → `409 conflict`).
- `class_state(class_key PK, last_status, last_open_seats, last_waitlist_open, updated_at)`
  — `last_status` is one of the `SeatStatus` union (`open|waitlist|closed`); drives the
  0→>0 transition detection (FR-4) and dedupe (FR-5). A `parser-broke` cycle does NOT
  overwrite these (FR-6).
- The store (emails + watch lists) is SENSITIVE (see constitution). Never log its rows.

## 6. Non-functional requirements

- Performance: detect→notify p95 < one poll interval + 5s. One fetch per unique class per
  interval regardless of subscriber count.
- Security/authz: no passwords; token links are signed + expiring + per-subscriber. Secrets
  (mail/VAPID) from env only. Untrusted-HTML handling per constitution. Tiny PII surface.
- Accessibility: dashboard meets WCAG 2.1 AA on the subscribe/manage flows.
- Observability: structured logs with opaque ids/counts only (no emails, no full watch
  lists); metrics for fetch latency, parse failures, alerts sent, dedupe suppressions.

## 7. Acceptance criteria (verifier runs these; each pass/fail; trace in brackets)

- AC-1 [FR-1, FR-2]: Subscribing with a valid email + class URL returns 201 with
  `{ subscriberId, token, watches }`, and the watch appears in the manage view fetched by
  that token.
- AC-2 [FR-1]: Subscribing with an invalid email (or an unrecognizable class identifier)
  shows an inline error and sends no request / creates no row.
- AC-2b [FR-1, §6 authz]: Creating with an email that already has a subscription returns
  `409 conflict`; the response carries no manage token, no `subscriberId`, and no watch list,
  and the existing subscription is unchanged (no merge, no enumeration leak).
- AC-3 [FR-3, FR-4]: Against a SAVED FIXTURE that flips 0 → >0 open seats, every subscriber
  of that class gets exactly one notification (verified via the no-op outbox).
- AC-4 [FR-4, FR-5]: A second poll with seats still >0 produces NO new notification (dedupe).
- AC-5 [FR-6]: A fixture whose HTML shape changed produces a "parser-broke" operator alert
  and zero subscriber notifications (and does not overwrite `class_state`).
- AC-6 [FR-7]: With `KILL_SWITCH=1`, a poll cycle performs no outbound fetch.
- AC-7 [FR-2, FR-4]: Unsubscribe via token removes the subscriber; a later opening sends
  them nothing.
- AC-8 [§6 observability]: No subscriber email or full watch list appears in any log line.

## 8. Task breakdown (dependencies & owners)

| #   | Task                                                                            | Owner role        | Depends on           |
| --- | ------------------------------------------------------------------------------- | ----------------- | -------------------- |
| 1   | API contract + shared types (`src/shared/**`) — DONE v0.2                       | architect         | —                    |
| 2   | Schema + migrations (subscribers, watches, class_state)                         | database-engineer | 1                    |
| 3   | Subscription/manage/unsubscribe endpoints + token links                         | backend-engineer  | 1, 2                 |
| 4   | `fetchClass` + parser + saved fixtures + parser-broke path                      | scraper-engineer  | 1                    |
| 5   | Poller (cadence/jitter/backoff/kill-switch) + 0→>0 detection + dedupe + fan-out | worker-engineer   | 1, 2, 4              |
| 6   | `dispatch` email (no-op + real) + optional web push                             | notifier-engineer | 1                    |
| 7   | Dashboard: subscribe + manage watches                                           | frontend-engineer | 1, 3                 |
| 8   | Unit + integration tests (incl. transition + dedupe + parser-broke)             | test-engineer     | 2–6                  |
| 9   | E2E journeys for each acceptance criterion                                      | e2e-qa-engineer   | 8                    |
| 10  | Containerize + CI (run gates incl. security STRICT)                             | devops-engineer   | 1 (refine after 3–7) |
| 11  | Security review (PII, egress, injection, secrets)                               | security-reviewer | 3–6                  |
| 12  | Code review (contract + lanes + standards)                                      | code-reviewer     | 3–7                  |

## 9. File-ownership map (no path owned twice)

- `specs/**`, `src/shared/**` → architect (contract read-only to all others)
- `src/db/**`, `drizzle/**` → database-engineer
- `src/server/**`, `src/api/**` → backend-engineer
- `src/client/**`, `src/components/**` → frontend-engineer
- `src/scraper/**` (incl. `src/scraper/fixtures/**`) → scraper-engineer
- `src/worker/**` → worker-engineer
- `src/notify/**` → notifier-engineer
- `tests/**` → test-engineer
- `e2e/**` → e2e-qa-engineer
- `Dockerfile`, `docker-compose*`, `Caddyfile`, `.github/**`, `.dockerignore` → devops-engineer
- The subscriber store (`data/**`, `*.sqlite*`) and any key files are SENSITIVE: no role
  edits them with the model; secrets come from the environment.
