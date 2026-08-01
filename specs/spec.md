# Spec: Berkeley Seat Sniper (notify-only)

> Living spec — the architect owns and versions this. When reality diverges, update this
> first, then let code follow. The API contract in `src/shared/**` is authoritative; this
> file summarizes it.
>
> Rev 2026-05-31 (v0.1): initial bound spec for the seat-sniper engine instance.
> Rev 2026-06-04 (v0.2): API contract authored in `src/shared/**` (class-key, seat-state,
> errors, api); §4/§5/§7/§8/§9 reconciled to it.
> Rev 2026-06-09 (v0.3): public-ready launch scope per the owner decision log
> (specs/audit-2026-06-09.md §6, D1–D14) and the ADR 0009 amendment. Double opt-in IN
> (202 subscribe, confirm route, token never in a response body); non-enumerating resend +
> per-email/per-IP rate limits; Resend bounce/complaint webhook + suppression; class-gone
> split from parser-broke (watch retirement); operator-alert debounce + required
> OPERATOR_EMAIL; web push IN (additive, alerts-only); RFC 9309 robots posture; the
> original fixed-cadence policy; seats-open-wins documented. Contract versioned in `src/shared/**`
> (api.ts, seat-state.ts, errors.ts) the same pass.
> Rev 2026-06-10 (v0.3.1): FR-8/§6 amendment (e2e-lane request, lead-approved): optional
> env-gated `NOOP_OUTBOX_FILE` NDJSON sink on the noop transport so black-box verification
> (Playwright, operator runbook) can extract confirm/manage links from the outbox. Off by
> default; dev/test only; AC text unchanged; NO contract change (`src/shared/**` untouched).
> Rev 2026-07-01 (v0.3.2): §6 amendment (code-review finding, v0.3 pass): `TOKEN_SECRET`
> added to the non-noop fail-loud env list (worker lane implements the startup probe).
> NO contract change (`src/shared/**` types/schemas untouched; comment-only note added in
> `class-key.ts`).
> Rev 2026-07-21 (v0.3.3): adversarial-audit amendments (duet section s20260721): §5 adds
> the `alert_deliveries` durable delivery ledger and narrows polled demand to Confirmed
> subscribers; §6 adds baseline-staleness rebaseline, delivery-durability semantics,
> suppression failure posture (dispatch fail-open documented; webhook persist failure →
> 5xx for provider retry), extended fail-loud (server-side token probe, production
> `DATABASE_URL`, all-or-nothing VAPID, boot-validated SMTP config), noop-only outbox
> retention, `.env` loading at entrypoints, send timeouts + bounded fan-out concurrency,
> transient-fetch backoff, robots Allow/longest-match, strict seat/waitlist parsing, and
> push-registration hardening. Contract change: `EnablePushRequestSchema.endpoint` is
> https-only (tightening; no route/shape changes).
> Rev 2026-07-23 (v0.4): owner-approved public launch contract. Subscriber identity is
> now an exact, double-opted-in `@berkeley.edu` mailbox (mailbox control, NOT current
> enrollment); the student-inaccessible SIS Class API is removed as a launch path and
> cache-aware public `classes.berkeley.edu` pages are the only v1 availability source.
> Source-visible freshness, polite capacity admission, Redis-backed abuse limits,
> at-least-once durable mail with one-hour Alert expiry, 72-hour Pending cleanup,
> 90-day terminal retention, and single-VPS pilot/public gates are bound below.
> Contract changes: bounded real-world `ClassKey` grammar; `SubscriberEmailSchema`;
> additive `watchFreshness`; and `payload_too_large` / `capacity_exceeded` errors.
> Rev 2026-07-23 (v0.4.1): fail-closed subscriber admission is explicit:
> `ADMISSION_MODE=closed|pilot|public` defaults to `closed`; pilot uses a shared,
> header-carried bearer code and an atomic 100-current-Subscriber cap; public admits any
> exact Berkeley mailbox request subject to double opt-in, abuse limits, and Section
> capacity. Admission denials are non-enumerating. Recovery enqueue faults return a
> constant generic 500 rather than a false 202. Provider batching is removed because each
> durable mail job is its own idempotency unit, and retry-stable rendered tokens derive
> from durable job timestamps. Contract changes: additive admission schemas/constants and
> `admission_unavailable`.
> Rev 2026-07-23 (v0.4.2): production-safety and activation semantics are pinned.
> Pending Watches are staged and consume zero source-capacity slots; confirmation
> atomically activates them subject to Confirmed-Section capacity. Subscriber plus tags
> are rejected. Production forbids noop mail, authenticates the Caddy proxy hop with a
> shared overwritten header, enforces a 32 KiB webhook ceiling, and requires a shared
> backup-success marker. Dead-letter incidents gain explicit operator state, the mail
> dispatcher is isolated from source scheduling, parser-broke alerts are durable
> once-until-recovery, and kill-switch operation is live-but-not-ready.
> Rev 2026-07-27 (v0.4.3): owner accepts proceeding on the public, unauthenticated
> `classes.berkeley.edu` pages without written or affirmative permission for recurring
> automated access. This is an explicit project-owner risk acceptance, not evidence or a
> claim of Berkeley authorization, endorsement, or legal clearance. The former
> permission/ToS launch blocker is replaced by mandatory source-safety controls: a current
> robots check that does not disallow the exact content path, one centralized deduplicated
> poller, cache-aware conditional requests, a contactable identifying User-Agent, the
> bounded global ceiling, backoff, and an immediate source stop on robots disallow, 403,
> 429, or observed operational harm. This amendment does not change the numeric source
> ceiling, freshness SLO, or capacity formula.
> Rev 2026-07-27 (v0.4.4): source-egress fail-closed behavior is pinned to the final
> implementation. Only exact `KILL_SWITCH=0` enables fetching; the effective source rate
> must be finite, positive, and at most 1 request/second. A 429 stop durably records the
> bounded effective cooldown in both the non-PII origin-state v2 `notBefore` field and the
> safety marker's `resumeNotBefore`, including the origin's bounded `Retry-After`; neither
> restart nor explicit reset can bypass it. Missing/malformed/unreadable state is repaired
> to reset time before clearing the fence only when an atomic state write succeeds;
> otherwise reset fails and source remains stopped. The later v0.4.6 revision strengthens
> valid-state reset monotonicity. NO API-contract or numeric-rate decision change.
> Rev 2026-07-27 (v0.4.5): the owner selects source-rate option A. Production
> `SOURCE_REQUESTS_PER_SECOND=1` is a strict ceiling of one physical Berkeley-origin
> request/second globally across the whole application—not per Subscriber, worker, or
> Section. `SOURCE_VISIBLE_TARGET_SECONDS=120` remains, yielding a maximum of 96 distinct
> activated live Sections watched by Confirmed Subscribers. Robots and redirect requests
> consume the same limiter; cache-aware scheduling can issue fewer requests. The numeric
> rate/capacity decision is closed, but this is not permission or launch readiness:
> `KILL_SWITCH=1` remains the tracked state until the separate live-source gates pass.
> Rev 2026-07-27 (v0.4.6): physical-request spacing is pinned at the limiter-owned,
> synchronous fetch-start boundary. Before invoking a physical request, the limiter
> durably writes a conservative start reservation; after invocation it reconciles the
> actual start before normal fence handoff. Reservation/reconciliation persistence
> failures retain the fence and fail closed. A graceful abort, kill-switch, or safety
> interruption after a successful durable reservation may release the fence normally,
> but leaves that future reservation intact so no later request can start early. Operator
> reset monotonically advances a valid last-permit boundary to at least reset time—never
> backward—while preserving any later cooldown. This closes the crash/reset spacing gap
> without changing option A's 1 request/second, 120-second target, or 96-Section maximum.
> NO API-contract change.
>
> Rev 2026-07-31 (v0.5.0): owner decisions of 2026-07-30 bound. BREAKING API-contract
> change, hence the minor bump rather than another patch. A Subscriber now holds at most
> 4 LIVE Watches (FR-24): `classKeys` is bounded by `MAX_WATCHES_PER_SUBSCRIBER` on the
> create path, and the add path gains a canonical `409 watch_limit_reached` distinct from
> `conflict` — the two demand opposite actions from the student, and the cap is evaluated
> before unique-Section capacity so a full Subscriber is told to remove one of their own
> rather than to wait. A per-Watch dashboard (FR-25) renders each watched class as a box
> with name, code, open seats out of total, open waitlist slots out of total, a derived
> link to the official page, and observation age; `watchFreshness` gains seven
> required-but-nullable observation fields and is now the authoritative per-Watch record,
> with `watches` retained as its derived projection. Open waitlist slots are
> `waitlistMax - waitlisted`, never `waitlisted`. Exactly three of those observations —
> `displayName`, `enrolled`, `capacity` — are NEW and OPTIONAL to the parser and can never
> produce `parser-broke` (FR-26); `waitlisted`/`waitlistMax` were already parsed STRICTLY and
> stay that way, and `openSeats` is strict in both directions (int4 NOT NULL, so a value above
> `MAX_OBSERVED_COUNT` yields `parser-broke`). `enablePush` now declares the
> `429 rate_limited` its mounted limiter already returns. Launch posture is local, then
> friends-only; the Public gate is retired as a v1 goal and the pilot Operator inbox is
> recorded as an explicit open blocker. AC-31–AC-34 added.

## 1. Problem & users

Berkeley email holders want a maxed-out class. When an enrolled student drops, the seat does
NOT cascade down the waitlist — it sits open as first-come-first-serve (same when a
waitlist slot frees). Students who learn of the opening first win it. **Users:** people
who can double-opt-in through an exact `@berkeley.edu` mailbox, launching first to a
student group. Mailbox control does **not** prove current student enrollment, affiliation,
or eligibility for a particular seat. **Now:** enrollment churn is highest near the term;
speed of notification is the whole value.

Terminology: the glossary in `CONTEXT.md` is the ubiquitous language. The watched unit is
a **Section**, realized in code as the canonical `ClassKey` / the `class_*` tables —
wherever code or this spec says "class," read "Section" (decision D11; no rename).

## 2. Scope

- **In scope (v1, PUBLIC-READY bundle — D1):** watch the PUBLIC, unauthenticated
  `classes.berkeley.edu` class pages (e.g.
  `classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001`), detect the open-seat
  transition, and alert subscribers after a changed page becomes visible through
  Berkeley's cache. Multi-user. A subscriber signs up with an exact `@berkeley.edu`
  address + a list of class URLs/codes, **confirms by email (double opt-in — D3)**, and
  manages watches via a thin web dashboard reached only through emailed links. Email
  alerts are the identity + baseline channel for everything; **web push is IN as an
  additive, alerts-only, best-effort channel** a Confirmed Subscriber can enable
  per-browser (D10). Includes the anti-abuse/deliverability surface: non-enumerating
  resend, Redis-backed per-email + per-IP rate limits (D6), bounce/complaint suppression
  via a signature-verified Resend webhook (D4/D5), operator alerting with debounce (D7),
  class-gone watch retirement (D8), and truthful per-watch source freshness.
  Public availability of these pages is the product's data-source basis; it is not
  represented as affirmative permission for recurring automated access or as Berkeley
  authorization or endorsement.
- **Rollout posture (D2):** pilot-first — the first launch is a closed pilot to a trusted
  student group — but the pilot runs the exact public-grade flow above and doubles as the
  low-volume warmup for the fresh sending subdomain (plan 0008). The token-in-body pilot
  (original ADR 0009 step 2) is withdrawn. Production admission fails closed: the
  application starts in `closed` and moves to invite-bearing `pilot` only after the hard
  gates pass.
  **Owner decision 2026-07-30 — `public` is NOT a v1 destination.** This service is local
  first, then friends-only by invitation, and is deliberately not opened to every Berkeley
  student. `pilot` is the terminal admission mode for v1. The `public` mode remains
  implemented and tested (AC-24, AC-25 and the fixtures that set `ADMISSION_MODE=public`
  are TEST settings, not launch intent), and the Rollout-gates section records the bar that
  would apply should the decision ever be revisited — but no work in v1 is scoped toward
  reaching it, and nothing should read the remaining public gates as pending work.
- **Explicit non-goals (v1):** NO credentials, NO CalNet, NO auto-enroll — the system must
  never need or store a student's login. No accounts/passwords. No SMS. A Discord bot is a
  documented swap, not the default. No scraping behind auth. No reselling/queuing of
  seats. The Berkeley SIS Class API is NOT a fallback: its access policy excludes
  students and the owner cannot obtain a faculty/staff sponsor. Also out of scope this
  pass (D-out): term-scoped expiry (plan 0004), course-level
  watches (plan 0002), reservation-aware eligibility (plan 0006 — but the reserved-seat
  caveat copy in alert emails IS in scope per ADR 0006's accepted mitigation), a SIS API
  adapter unless Berkeley later changes student-access policy, chat-webhook operator
  channel, subscriber notification on watch
  retirement (a retired watch silently leaves the manage view), and proof of current
  enrollment or seat eligibility.

## 3. Functional requirements (numbered, testable)

- FR-1: When admission allows a new Subscriber, a visitor can subscribe with an exact
  `@berkeley.edu` email + ≥1 class URL/code; the address is trimmed/lowercased and the
  class identifier is normalized to a canonical class key. Subdomains and lookalike
  suffixes are rejected. A `+tag` in the subscriber local part is rejected at create,
  resend, and every other subscriber-identity boundary; the corresponding base address
  remains valid. This prevents one mailbox bypassing identity, rate, admission, or
  uniqueness controls through aliases. The response is
  `202 { status: 'pending' }` — it carries NO manage token and NO subscriberId (D3).
  Confirmation proves mailbox control only.
- FR-2: A subscriber can list, add, and remove watches, and unsubscribe entirely, via a
  link that needs no password (signed, expiring token). The token reaches the subscriber
  ONLY by email (out-of-band); it never appears in any API response body.
- FR-3: ONE poller fetches each UNIQUE watched class, respecting public response cache
  metadata, a global origin-rate ceiling, jitter, and backoff, then fans out to all
  subscribers of that class. Never one fetch per subscriber. The selected ceiling is one
  physical Berkeley-origin request/second globally across the entire application—not per
  Subscriber, worker/process, or Section. Robots, class-page, conditional, and redirect
  request attempts all consume this same limiter. Spacing is measured between actual
  physical request-start invocations at a limiter-owned synchronous boundary, not between
  scheduler wakeups or permit-return timestamps. A cache-fresh Section consumes no
  request. Scarce capacity counts only distinct live Sections held by at least one
  Confirmed Subscriber and is capped at 96 under the selected rate/target. Pending
  Watches are staged: they consume zero slots, create no source demand, and never make
  create or a Pending add-Watch fail for source capacity. Confirmation atomically
  activates every staged live Watch only if their union with current Confirmed demand
  fits. A Confirmed add-Watch or Pending confirmation that would introduce too many
  unique Sections returns `503 capacity_exceeded` + `Retry-After`; no partial activation
  occurs and existing Watches keep running.
- FR-4: When a class transitions from 0 → >0 open seats (or a waitlist slot frees per the
  page), durable email work is enqueued for each **Confirmed** subscriber of that class,
  and web push is attempted for each browser they registered. Email is **at least once**:
  provider idempotency suppresses ordinary retries, but a crash after provider acceptance
  and before the durable success mark can produce a rare duplicate. Losing an Alert is
  less acceptable than that duplicate. Push is best-effort and never holds email open.
- FR-5: A flapping seat (0→1→0→1) does not re-notify until it has closed and re-opened.
  Corollary (documented baseline rule): the first observed state of a class sets the
  baseline without notifying, so a watch added while a class is already open alerts only
  after it closes and re-opens.
- FR-6: If the parser can no longer read a page that still exists (200 but unparseable),
  the system emits a distinct operator "parser-broke" alert and does NOT emit false
  "0 seats" or false openings. `class_state` is never overwritten by such a cycle.
- FR-7: Cadence (`POLL_INTERVAL_SECONDS`), jitter, backoff, identifying `User-Agent`, and
  a global kill-switch are configurable via environment; robots.txt is respected with the
  RFC 9309 posture (§6). Source access is explicit opt-in: only the exact string
  `KILL_SWITCH=0` enables fetching; `1`, missing, empty, malformed, and every other value
  disable only source fetching. Liveness and recovery/manage/unsubscribe ingress remain
  available, queued mail/retention work may continue, and aggregate operational readiness
  reports `disabled` / not-ready. Before live class-page fetching, the configured
  User-Agent must identify Seat Sniper and give a monitored contact, and the current
  robots policy must not disallow the exact content path. A robots disallow or any
  class-page `403` or `429` aborts the remaining source cycle and engages a durable
  source-safety stop: no further class-page fetch is permitted until explicit Operator
  review and reset. For a 429, the worker first persists the bounded effective recovery
  deadline in origin-state v2 `notBefore`, then stores the same delay in the marker's
  `resumeNotBefore`; both contain only fixed timestamps/reason. The delay is derived from
  the greater of worker backoff and bounded origin `Retry-After`, with jitter and a
  24-hour cap. Origin permits use the later of configured last-permit spacing and
  `notBefore`, and consume the cooldown only when a permit commits. Process
  restart/recreation and explicit reset cannot resume before the effective deadline. An
  Operator who sees operational-harm signals (including origin errors/latency correlated
  with polling or a direct stop request) sets exact `KILL_SWITCH=1` immediately. Backoff
  is additional protection, not permission to continue after a safety-stop trigger.
- FR-8: A no-op mail transport (`MAIL_TRANSPORT=noop`) delivers to an inspectable outbox,
  and a fake push transport records push payloads, so the whole pipeline is verifiable
  without sending real mail or push. Saved fixtures + the noop outbox/fake clients are the
  verification universe for every AC. Black-box access (v0.3.1): when `NOOP_OUTBOX_FILE`
  is set AND the transport is noop, each outbox entry (kind, to, subject, body) is also
  appended as one NDJSON line to that path so E2E and the operator runbook can extract
  the emailed links; the file contains PII + tokens by design — dev/test only, gitignored
  path, never set in production; default unset (stdout still logs subject only; AC-8
  posture unchanged). `NODE_ENV=production` forbids the noop transport and any non-empty
  `NOOP_OUTBOX_FILE`; a real, fully configured mail transport is mandatory.
- FR-9 (double opt-in — D3): subscribing creates a **Pending** Subscriber and sends a
  confirmation email carrying the confirm link. A confirm endpoint atomically flips
  Pending → Confirmed and activates all staged live Watches subject to FR-3. Capacity
  failure leaves both the Subscriber and every Watch Pending/staged so the same token can
  be retried after removing Watches or capacity becomes available. Once confirmed, the
  route is permanently idempotent: later calls return the same 200 without rechecking
  capacity or changing confirmation/activation timestamps. Only Confirmed Subscribers
  receive Alerts (email or push).
- FR-10 (resend — D6): `POST /api/subscriptions/resend { email }` always returns
  `202 { status: 'sent' }` with a constant-shaped body whether or not the address is
  subscribed (non-enumerating); mail is actually sent only to a subscribed address. A
  successful response means the durable lookup/enqueue operation completed, not that the
  provider has already accepted mail. If that persistence operation fails, the route
  returns the same generic `500 internal_error` body for known, unknown, and suppressed
  addresses; it must never return a false 202 for a known lost recovery request.
- FR-11 (rate limits — D6): subscribe and resend enforce BOTH a per-IP and a per-email
  window; exceeding either returns `429 rate_limited`.
- FR-12 (suppression — D4/D5): a signature-verified Resend webhook records hard-bounced
  and complained addresses in a suppression store; the notifier never sends ANY
  subscriber-facing mail (alert, confirmation, manage-link) to a suppressed address.
  Operator alerts are exempt (internal, not subscriber-facing). The raw webhook body has
  an exact 32 KiB (32,768-byte) ceiling enforced before JSON parsing or signature work;
  an oversized body is always canonical `413 payload_too_large`.
- FR-13 (class-gone — D8): a 404 / known not-found page produces a distinct `class-gone`
  signal (not `parser-broke`); the worker retires every watch on that class (no longer
  polled, no longer listed in manage) and does NOT page the operator and does NOT alert
  subscribers. `class_state` is never overwritten by such a cycle.
- FR-14 (operator alerting — D7): operator alerts go to `OPERATOR_EMAIL`, which is
  REQUIRED (fail-loud at startup) for any non-noop transport. A persistent break alerts
  the operator exactly ONCE per parser-broke episode across cycles, elapsed time, process
  restart, and worker failover. No cooldown can re-alert a still-broken Section. Only a
  later successful parse records recovery and arms one alert for a subsequent break.
- FR-15 (web push — D10): a Confirmed Subscriber can enable/disable push per-browser from
  the manage view (auth = manage token). Push carries ONLY seat/waitlist Alert payloads —
  never Confirmation or Manage links, never tokens. A push failure never blocks or delays
  the email alert. VAPID keys come from env; absent keys disable the feature gracefully.
- FR-16 (source truthfulness): availability comes only from the public class page. The
  manage contract exposes, for each live Watch, the last successfully parsed page time
  and whether it is stale. Product copy promises notification within two minutes after a
  changed page representation becomes observable to the service; it never promises
  proximity to an underlying SIS event. Cache age can therefore dominate end-to-end lag.
- FR-17 (durable mail): Confirmation, Manage-link, Alert, and Operator email is enqueued
  transactionally and drained by one dispatcher loop isolated from source scheduling.
  No production job stores a raw manage
  token or denormalized recipient address; those are resolved/minted at send time.
  Opening Alerts are cancelled if the opening closes before dispatch and expire one hour
  after observation. Each claimed job is one provider request with its own stable
  idempotency key; provider batching is forbidden because the membership of a transient
  claim batch is not a durable retry unit. Retry rendering is byte-stable: Alert tokens
  derive from durable `opened_at`, and Confirmation/Manage-link tokens derive from the
  durable outbox `created_at`, never the wall clock at dispatch. Permanent failures and
  exhausted retry horizons become durable dead-letter incidents (§5/FR-22).
- FR-18 (bounded retention): unconfirmed Pending Subscribers and their dependent rows are
  purged 72 hours after creation. Sent/cancelled/dead-letter mail jobs and delivery-ledger
  rows, plus retired Watches and orphaned class state, are purged after 90 days, except
  jobs referenced by unresolved or acknowledged dead-letter incidents are retained until
  resolution.
  Deliverability suppressions remain until an Operator explicitly clears them.
- FR-19 (subscriber admission): `ADMISSION_MODE` is exactly
  `closed | pilot | public`; absent means `closed`, and an invalid value fails startup.
  `closed` rejects only NEW subscription creation—resend, confirmation, and every
  token-scoped manage/unsubscribe/push/watch route remain available. `pilot` additionally
  requires the shared invite bearer in `x-seat-sniper-invite-code` and atomically limits
  all current Pending + Confirmed Subscriber rows to 100; unsubscribe and the 72-hour
  Pending purge release a slot. `public` requires no invite and accepts any exact
  `@berkeley.edu` request subject to ordinary rate limits and the confirmation-time
  unique-Section capacity check.
  Closed, missing/wrong/malformed/oversize pilot bearer, and full-pilot rejection are
  deliberately indistinguishable: the same status, body, and Retry-After, with no
  mode/code/count disclosure. The invite is an env-only shared bearer secret: timing-safe
  digest compare, never stored, echoed, included in durable work, or logged.
- FR-20 (authenticated proxy identity): forwarded client IP is trusted only when
  `TRUST_PROXY=1` AND the request carries the exact `x-seat-sniper-proxy-secret` value
  configured in `PROXY_HEADER_SECRET`. Caddy strips any client-supplied copy and overwrites
  it on every upstream request. A private source address alone is never sufficient; a
  missing/wrong secret makes the application ignore all forwarded-address headers.
- FR-21 (operational health): `/api/health` is process liveness and does not aggregate
  dependencies. The private aggregate readiness probe reports not-ready for a disabled
  source, stale worker/source, unresolved dead letters, unhealthy dependencies/backlog/
  disk, or a missing/stale/malformed production backup-success marker. Caddy/container
  startup gates use liveness, never aggregate readiness, so recovery ingress remains
  reachable during an operational incident.
- FR-22 (dead-letter operations): every first transition to `dead_letter` atomically
  opens one durable incident with state `unresolved`; an external monitor surfaces one
  logical alert keyed by that incident id. Operator actions explicitly move the incident
  to `acknowledged` or `resolved`, and only `unresolved` incidents fail readiness.
  Reprocessing does not silently resolve an incident. A failed `operator` mail job opens
  an incident but MUST NOT enqueue another Operator job, preventing recursive alert chains.
- FR-23 (scheduler isolation): source scheduling and outbox dispatch run as independent,
  concurrent loops with separate bounded work/concurrency and no provider await or outbox
  drain on the source-cycle critical path. Slow/hung mail delivery must not delay an
  eligible source fetch or lease heartbeat beyond the source-visible SLO.
- FR-24 (watch cap): a Subscriber holds at most `MAX_WATCHES_PER_SUBSCRIBER` (4) LIVE
  Watches. Freeing a slot is a deliberate act — to watch a fifth class the student removes
  one first. The number is contract-level (`src/shared/**`), not a data-layer constant, so
  the dashboard can render "3 of 4" without importing `src/db`. The cap is enforced on BOTH
  write paths and neither alone is sufficient: the create path bounds `classKeys` and
  rejects `400 validation_error` before a Subscriber exists, while the add path counts LIVE
  rows and rejects `409 watch_limit_reached`. Retired Watches do NOT consume a slot, so a
  class-gone retirement (FR-13) frees one, and reviving a retired Watch while already at the
  cap is refused. Pending Subscribers are capped identically, so the cap cannot be bypassed
  before confirmation. The cap is evaluated BEFORE the unique-Section capacity check so a
  full Subscriber is told to remove one of their own rather than to wait.
  **Upgrade policy (the cap binds NEW WRITES; it does not retroactively repair stored data).**
  v0.4 permitted 50 LIVE Watches. Migration `0011` adds dashboard columns only, so upgrading a
  populated v0.4 database preserves any Subscriber already holding more than four — the
  new-write checks cannot see existing rows, and the invariant above would be false for that
  data. This is resolved as an explicit WAIVER plus a precondition, not by silent repair:
  - **Waiver (current, and the reason this does not block v0.5.0):** no such database exists.
    The service has never been deployed; there is no production or pilot data, and the local
    verification path creates a fresh database. The invariant therefore holds for every
    database that actually exists.
  - **Precondition (binding on any future upgrade):** before migrating a populated v0.4
    database, over-cap Subscribers MUST be resolved by an Operator. If one is ever detected,
    the app logs a loud operator-facing event and aggregate readiness reports NOT READY until
    it is resolved — the same shape as an unresolved dead letter (FR-21/FR-22). It MUST NOT
    refuse to boot: FR-21/AC-29 require that recovery ingress and the existing subscriber
    manage journey stay reachable during an incident.
  - **The system MUST NOT auto-retire Watches to force compliance.** Choosing which of a
    student's classes to stop watching is exactly the deliberate act this cap exists to make
    them perform; picking arbitrarily on their behalf would silently stop alerts for a class
    they still want and is strictly worse than the invariant being temporarily false.
- FR-25 (watch dashboard): the manage view presents every LIVE Watch as one box so a
  student can decide what to stop watching and free a slot. Each box shows the class name,
  the enrollment code, open enrollment seats out of total, open waitlist slots out of total,
  a link to the official class page, and how stale the observation is. Observations are
  carried per Watch on `watchFreshness` (§4) and every one is nullable: a Watch whose
  Section has never been polled renders each unknown value as a dash and MUST NOT error.
  Staleness is not decoration — a box showing seat counts without showing the age of the
  observation invites a student to act on a number the poller has not refreshed. Open
  waitlist slots are `waitlistMax - waitlisted`, never `waitlisted` itself. A retired Watch
  leaves the dashboard silently (FR-13, §2 non-goal); the freed slot is immediately usable.
  Parsing MUST NOT become stricter to serve this view — see FR-6 and FR-26.
- FR-26 (dashboard observations never break the parser): the NEW observations behind FR-25
  are exactly `displayName`, `enrolled`, and `capacity`, and those three are OPTIONAL to the
  parser. A missing, malformed, or out-of-bound value for any of them yields `null` and the
  poll continues; it MUST NEVER yield `parser-broke`. Making one required would turn a
  healthy page whose markup merely differs into an operator page-out that also suppresses
  that cycle's Subscriber alerts — strictly worse than a missing number.
  `waitlisted` and `waitlistMax` are NOT in that set. They are PRE-EXISTING STRICT inputs
  (FR-6): the parser already required them, `waitlistOpen` is derived from them, and that
  derivation drives alerting — so a page that stops publishing them is a genuine parser
  break, not a missing decoration. The dashboard merely persists and displays values the
  parser was already reading. Their PRESENCE is strict; their PERSISTENCE is lenient, and
  they are nullable in `class_state` and on the wire for exactly two reasons — a Watch whose
  Section has never been polled has no observation at all (a different fact from "the page
  omitted them"), and a count above `MAX_OBSERVED_COUNT` (int4 max, `src/shared/seat-state.ts`)
  is stored as `null` rather than breaking a parse that otherwise succeeded.
  **Total Open Seats is the exception and stays strict in BOTH directions**: `last_open_seats`
  is int4 NOT NULL, so it can be neither absent nor degraded to `null`. A page reporting more
  than `MAX_OBSERVED_COUNT` open seats yields `parser-broke`, because that value is unreadable
  rather than informative, it drives transition detection and alerting, and an unbounded value
  would otherwise parse cleanly and then fail the upsert mid-poll — a crash, not a graceful
  degradation. Widening it to nullable would widen the core state, transition, and storage
  contracts for no product return. A
  successful 200 whose optional markup is absent explicitly CLEARS those values to null,
  while a 304 preserves the prior observation: observed-absent and not-observed are
  different facts and must not be collapsed.

## 4. API contract (summary; `src/shared/**` is authoritative)

Request bodies accept a class identifier as a URL **or** a code; both normalize to a
canonical `ClassKey` at the boundary (FR-1). Error responses are the envelope
`{ error: ApiError }` (never a bare body). Token-scoped routes use the signed/expiring
per-subscriber `token` in the path — a bad/expired token → `token_invalid` (401), a valid
token for a missing subscriber → `not_found` (404).

Subscriber identity uses `SubscriberEmailSchema`: trim + lowercase + syntactically valid
email + exact `berkeley.edu` domain + no `+` in the local part. `EmailSchema` remains
generic for trusted operator, sender, and third-party payload validation. The distinction
prevents subscriber policy from accidentally rejecting a non-Berkeley operations mailbox.

All request bodies are bounded before parsing. The general JSON ceiling is 64 KiB. The
raw Resend webhook ceiling is exactly 32 KiB (`RESEND_WEBHOOK_MAX_BODY_BYTES = 32_768`) at
both edge and application: 32,768 bytes may proceed; 32,769 bytes returns canonical
`413 payload_too_large` before signature verification or JSON parsing, even if signature
headers are absent/invalid. No rejected raw body or signature/header value is logged.
`503 capacity_exceeded` means accepting a new unique Section would violate the configured
polite source budget; it includes decimal-delta
`Retry-After: <SOURCE_VISIBLE_TARGET_SECONDS>` and never evicts existing Watches.

New-Subscriber admission is independent of source capacity. `POST /api/subscriptions`
retains the JSON body `{ email, classKeys }`; its only additive input is the optional,
case-insensitive `x-seat-sniper-invite-code` header (32–256 unpadded-base64url
characters). In `pilot` it must exactly match `PILOT_INVITE_CODE`; in `closed` it cannot
enable creation; in `public` it is ignored. Closed admission,
missing/wrong/malformed/oversize pilot bearer, and the pilot's atomic
100-current-Subscriber cap all return the byte-identical
`503 { error: { code: 'admission_unavailable', message:
'new subscriptions are not currently available' } }` with
`Retry-After: 3600`. The response never identifies mode, invite validity, or account
count. A malformed invite header is an admission denial, not a field-level
`validation_error`. Rate limits still apply so this shared bearer cannot be brute-forced.

**Confirm-token semantics (architect decision, v0.3):** there is ONE token type — the
signed manage token (HMAC over `{ subscriberId, exp }`). The confirm link carries the
SAME token; `POST /api/subscriptions/:token/confirm` verifies it and sets `confirmed_at`.
This is the simplest design consistent with ADR 0001 ("followed the link at least once" =
confirmed): one mint path, one verify path, and the resend flow needs no second token
kind. Confirmation is an explicit POST (never a side effect of GET) so a mail scanner
prefetching links cannot auto-confirm; the confirm landing page requires a user gesture.

Public (no auth):

- `POST /api/subscriptions` `{ email, classKeys: string[] (1–MAX_WATCHES_PER_SUBSCRIBER) }` →
  `202 { status: 'pending' }` | `400 validation_error` | `413 payload_too_large` |
  `409 conflict` | `429 rate_limited` | `500 internal_error` |
  `503 admission_unavailable`
  - `classKeys` is bounded by `MAX_WATCHES_PER_SUBSCRIBER` (4), so an over-cap create is
    rejected `400 validation_error` BEFORE any Subscriber row exists. This bound is
    load-bearing, not cosmetic: the per-add cap cannot see a batch create, so without it a
    new Subscriber could be created holding an unbounded Watch set and never meet the cap
    (FR-24). The repository create path enforces the same ceiling independently; both are
    required.
  - Optional request header: `x-seat-sniper-invite-code: <shared bearer>`; required only
    in `pilot`, ignored in `public`, and incapable of opening `closed`.
  - The 202 body NEVER contains a token, subscriberId, or watch list (FR-9). Side effect:
    a Pending Subscriber + staged Watches are created and a confirmation email is
    dispatched (withheld without changing the response if the address is suppressed,
    FR-12). Staging consumes no source-capacity slot.
  - Duplicate email on create → `409 conflict`, constant-shaped error envelope only: no
    token, no subscriberId, no watch list, no merge into the existing subscription
    (prevents account takeover). Residual tradeoff (accepted, documented): the 409 itself
    reveals that an address is subscribed; it is blunted by FR-11 rate limits, and the
    non-enumerating recovery path is the resend route.
- `POST /api/subscriptions/resend` `{ email }` → `202 { status: 'sent' }` (always, FR-10)
  | `400 validation_error` (malformed/ineligible email shape only) |
  `413 payload_too_large` | `429 rate_limited` | `500 internal_error`
  - If the address is subscribed: Pending → re-send the confirmation email; Confirmed →
    send a fresh manage-link email. Unknown or suppressed → send nothing. All paths do
    comparable work (no timing oracle) and return the identical 202 body.
  - The lookup and conditional durable enqueue are one persistence operation. If that
    dependency fails—including a known address whose mail job cannot be committed—the
    route returns the byte-identical generic
    `500 { error: { code: 'internal_error', message:
'the request could not be processed; please try again later' } }` for known, unknown,
    and suppressed input. It does not claim `sent` and does not expose which branch failed.
  - Implementation note: register this static path BEFORE the `/:token` routes so `resend`
    is never captured as a token segment.
- `POST /api/webhooks/resend` (body = raw Resend/Svix event; signature verified from the
  `svix-id` / `svix-timestamp` / `svix-signature` headers against
  `RESEND_WEBHOOK_SECRET`) → `204` | `401 signature_invalid` | `413 payload_too_large`
  - On `email.complained`, and on `email.bounced` unless the payload marks the bounce
    explicitly transient/soft, every recipient address is suppressed (suppress-by-default
    protects sender reputation). Valid-signature events we don't act on → `204` (ack,
    ignore). The shared helper `suppressionsFromResendEvent` is the single classification
    authority. Bad/missing signature → `401 signature_invalid`, no state change.
  - Webhook logs use only these fixed classifications (plus opaque request/incident ids):
    `payload_too_large`, `signature_missing`, `signature_malformed`, `signature_stale`,
    `signature_mismatch`, `payload_invalid`, `ignored`, `suppressed`, and
    `suppression_persist_failed`. Provider event types, recipient addresses, raw values,
    parser errors, and exception messages are never log fields.
- `GET /api/push/vapid-public-key` → `200 { publicKey: string | null }` — `null` when
  VAPID is not configured (UI then hides the push toggle). Public by design.
- `GET /api/health` → `200 { status: 'ok' }` — ops-only liveness probe, intentionally
  outside the contract route table.

Token-scoped (signed manage token in path):

- `POST /api/subscriptions/:token/confirm` → `200 { status: 'confirmed' }` |
  `400 validation_error` | `401 token_invalid` | `404 not_found` |
  `413 payload_too_large` |
  `503 capacity_exceeded` + `Retry-After` — the first successful call atomically confirms
  and activates all staged live Watches. Capacity failure rolls back the whole transition
  and leaves the Subscriber Pending; no Watch becomes source demand. Already-Confirmed is
  checked first and always returns the same 200 without rechecking current capacity or
  changing any timestamp/order (FR-9).
- `GET  /api/subscriptions/:token` →
  `200 { email, confirmed: boolean, watches: ClassKey[], watchFreshness:
  WatchFreshness[] }`
  | `401 token_invalid` | `404 not_found` — `watches` lists LIVE (un-retired) watches
  only; for `confirmed: false` these are staged and do not themselves drive polling.
  Freshness may reflect another Confirmed subscriber's shared demand for that Section;
  otherwise it is never-observed/stale. The flag lets the manage view show a confirm prompt.
  `watchFreshness`
  has exactly one same-order entry per Watch:
  `{ classKey, source: 'public-class-page', lastCheckedAt: datetime|null,
sourceStale: boolean, displayName: string|null, openSeats: int|null, enrolled: int|null,
capacity: int|null, waitlisted: int|null, waitlistMax: int|null,
waitlistOpen: boolean|null }`. `lastCheckedAt` is a successful public-page parse, not an SIS
  timestamp; `sourceStale` is true when no baseline exists or the cache-aware next-check
  deadline plus the two-minute target has passed.
  `watches` is a DERIVED projection of `watchFreshness` (same order, same length) and is
  retained for compatibility; `watchFreshness` is the authoritative per-Watch record.
  The seven observation fields drive the dashboard (FR-25). Each is REQUIRED-BUT-NULLABLE:
  the key is always present and `null` means "not observed yet". They are LEFT-joined from
  `class_state`, so a Watch whose Section has never been polled carries `null` for all seven
  — a normal new Watch, not an error. `waitlisted` counts students QUEUED on the waitlist,
  NOT open waitlist slots; open slots are `waitlistMax - waitlisted`, and a rendered
  open-waitlist count > 0 IMPLIES `waitlistOpen` is true (not a biconditional — `waitlistOpen`
  true with null counts, or `waitlistOpen` null, both render a dash). The official class URL is DERIVED from
  `classKey` and is never stored per row nor taken from the page; `displayName` is
  display-only and is never an identity input, lookup key, or part of a ClassKey.
- `POST /api/subscriptions/:token/watches` `{ classKey }` →
  `200 { watches: ClassKey[], watchFreshness: WatchFreshness[] }` |
  `400 validation_error` | `401 token_invalid` | `404 not_found` | `409 conflict` |
  `409 watch_limit_reached` |
  `413 payload_too_large` | `503 capacity_exceeded` — re-adding a class whose watch was
  retired REVIVES that watch (§5); a duplicate LIVE watch → `409 conflict`. For a Pending
  Subscriber this only stages/revives and cannot return `capacity_exceeded`; for a
  Confirmed Subscriber activation and the capacity check are atomic.
  `409 watch_limit_reached` means the Subscriber already holds
  `MAX_WATCHES_PER_SUBSCRIBER` (4) LIVE Watches (FR-24). It is DISTINCT from `conflict`
  because the two demand opposite actions from the student — "you already watch this"
  versus "remove one to free a slot" — and distinct from `capacity_exceeded`, which is a
  retryable service-wide condition carrying `Retry-After`. `watch_limit_reached` is not
  retryable and carries no `Retry-After`; only the Subscriber removing a Watch clears it.
  The personal cap is evaluated BEFORE the unique-Section capacity check, so a full
  Subscriber is told to remove one of their own rather than to wait for the service.
- `DELETE /api/subscriptions/:token/watches/:classKey` (`:classKey` is canonical) →
  `204` | `400 validation_error` (non-canonical `:classKey`) | `401 token_invalid` |
  `404 not_found`
- `DELETE /api/subscriptions/:token` (unsubscribe) → `204` | `401 token_invalid` |
  `404 not_found`
- `POST /api/subscriptions/:token/unsubscribe` (RFC 8058 one-click target for the
  `List-Unsubscribe-Post` header; request body accepted and ignored) → `204` | same
  errors as DELETE | `413 payload_too_large`. Mail providers POST here; semantics
  identical to the DELETE.
- `POST /api/subscriptions/:token/push` `{ endpoint, keys: { p256dh, auth } }` →
  `201 { status: 'enabled' }` | `400 validation_error` | `401 token_invalid` |
  `404 not_found` | `409 conflict` (subscriber not yet Confirmed — confirm first, FR-15) |
  `413 payload_too_large` | `429 rate_limited` (the route is mounted behind the per-IP
  limiter, so a 429 is an observable response and the contract must declare it)
  - Idempotent upsert keyed on `endpoint` (globally unique): re-registering updates keys;
    an endpoint previously registered to a DIFFERENT subscriber is reassigned (last write
    wins — the browser belongs to whoever holds the token and the device). Extra browser
    fields (`expirationTime`) are ignored. Accepted even when VAPID is unconfigured
    (registration is inert until keys exist).
- `DELETE /api/subscriptions/:token/push` `{ endpoint }` → `204` (idempotent — unknown
  endpoint still 204) | `400 validation_error` | `401 token_invalid` | `404 not_found` |
  `413 payload_too_large`

Emailed links (pinned cross-lane format — notify builds them, frontend routes them, tests
extract them from the noop outbox):

- Confirm link: `${APP_BASE_URL}/?confirm=<token>` — confirmation emails (subscribe +
  resend-while-Pending). The landing view explains and offers a "Confirm subscription"
  button that calls the confirm endpoint, then shows the manage view.
- Manage link: `${APP_BASE_URL}/?token=<token>` — manage-link emails (resend-while-
  Confirmed) and the manage/unsubscribe links inside alert emails.
- Push payloads contain NEITHER link and no token (FR-15); the push click-through derives
  `https://classes.berkeley.edu/content/<classKey>` from the payload's classKey.

Pilot invite journey (pinned cross-lane format — operator shares it, frontend consumes it,
backend validates the header):

- The Operator privately shares `${APP_BASE_URL}/?invite=<urlencoded-code>`. The invite is
  shared bearer access, not identity or mailbox verification; anyone who obtains it and
  controls an exact Berkeley mailbox can request pilot admission.
- On first-party page load the client reads `invite`, immediately calls
  `history.replaceState` to remove it from the visible URL/history before rendering or
  making another request, and keeps it only in tab-scoped `sessionStorage`. It is never
  written to localStorage, IndexedDB, a cookie, analytics, telemetry, or a service-worker
  cache. The client sends it only as `x-seat-sniper-invite-code` on create, then clears the
  session copy after a 202.
- Caddy/application logs must omit request URI, query, headers, and raw request bodies so
  neither the initial bearer URL nor the create header is retained. Operator sharing must
  not use public chat, ticket attachments, URL shorteners, or third-party link tracking.

Outbox kinds (noop transport; test surface required by §7): every outbox entry carries a
`kind` ∈ `'alert' | 'confirmation' | 'manage-link' | 'operator'`, and confirmation /
manage-link bodies contain their absolute link on its own line so tests can extract it
with a regex. The fake push transport records `(endpoint, payload)` pairs.

Worker→notifier event (D13, accepted behavior): when seats AND the waitlist open in the
same poll cycle, the worker emits ONE `NotifyEvent` and `seats-open` wins (the
more-actionable signal). A simultaneous double-opening is deliberately not double-alerted.

Shared types (`src/shared/`): generic `EmailSchema` plus base-address exact-domain
`SubscriberEmailSchema` (`email.ts`); `ClassKey` (branded) + `normalizeClassKey`
(`class-key.ts`) with bounded real catalog identifiers (numeric or alphanumeric section /
component ids up to 8 characters and alphabetic component codes up to 8 characters);
`SeatState { classKey, status, openSeats, waitlistOpen, fetchedAt, displayName?, enrolled?,
capacity?, waitlisted?, waitlistMax? }` (the five trailing observations are OPTIONAL here —
see §5 and FR-26 — while their `WatchFreshness` counterparts are required-but-nullable),
`MAX_OBSERVED_COUNT`,
`ParseResult = SeatState | { kind: 'parser-broke', … } | { kind: 'class-gone', … }`,
`NotifyEvent`, `PushAlertPayload`, `Subscriber` (`seat-state.ts`); `ApiError { code,
message, fields? }` with a fixed `code` union (now incl. `signature_invalid`), wrapped in
`{ error }` (`errors.ts`); per-endpoint request/response/param schemas, the Resend webhook
event schema + `suppressionsFromResendEvent`, and the `API_ROUTES` table (`api.ts`). No
internals leaked. `src/shared` imports nothing outside itself except `zod` (it is bundled
client-side — no node builtins). Admission additions are `AdmissionModeSchema`,
`DEFAULT_ADMISSION_MODE`, `PILOT_SUBSCRIBER_LIMIT`,
`PILOT_INVITE_CODE_HEADER`, `PILOT_INVITE_CODE_MIN_LENGTH`,
`PILOT_INVITE_CODE_MAX_LENGTH`, `CreateSubscriptionHeadersSchema`,
`ADMISSION_UNAVAILABLE_MESSAGE`, `ADMISSION_RETRY_AFTER_SECONDS`, and
`RESEND_WEBHOOK_MAX_BODY_BYTES`.

## 5. Data model (database-engineer; reconcile with §4 and `src/shared/`)

Every `class_key` column stores the canonical `ClassKey` from `src/shared/class-key.ts`
(validate with `ClassKeySchema` on the way in). `class_state` mirrors `SeatState`, which
carries `classKey, status, openSeats, waitlistOpen, fetchedAt` plus the FR-25 observations
`displayName, enrolled, capacity, waitlisted, waitlistMax`. Those five are OPTIONAL on
`SeatState` — unlike their required-but-nullable counterparts on the wire
(`WatchFreshness`, §4) — because `SeatState` has exactly one producer, `parseClassPage`,
so compiler-enforced strictness buys no safety there and only churns construction sites.
"Class" here = Section (CONTEXT.md).

- `subscribers(id, email UNIQUE, confirmed_at NULL, created_at)` — `email` is PII and
  MUST satisfy the normalized exact-`berkeley.edu`, base-address-only constraint as well
  as the shared schema; `id` is the opaque id. `confirmed_at IS NULL` = Pending; set once
  by the confirm endpoint
  (idempotent — never updated after first set). The signed manage `token` is derived from
  `id` (not stored); expiry enforced at verification (FR-2). Pending rows that remain
  unconfirmed for 72 hours are purged with dependent rows. Pilot admission takes a
  transaction-scoped lock, counts every current row (Pending + Confirmed), and inserts
  only when the count is below 100. The count and insert are one atomic operation across
  API instances; no invite code/hash or per-subscriber invite marker is stored.
- `watches(id, subscriber_id FK cascade, class_key, activated_at NULL,
activation_order NULL, retired_at NULL, created_at)` — index `(class_key)` for fan-out;
  unique `(subscriber_id, class_key)`. Pending Watches have NULL activation fields and
  consume no source capacity. First confirmation locks the capacity decision and sets
  `confirmed_at`, `activated_at`, and a deterministic activation order for every staged
  live Watch in one transaction; confirmed add/revive activates immediately in the same
  capacity-check transaction. No partial activation is valid. `retired_at` decision
  (architect): soft-retire via a nullable timestamp rather than delete — it preserves the
  glossary's live/retired Watch semantics, is what the deferred term-expiry plan will
  reuse, and avoids destructive writes from the worker. A retired watch is excluded from
  polling, fan-out, and the manage view. Re-adding the same class revives the retired row
  (clears `retired_at` — keeps the unique constraint, and honestly re-tests a class that
  may have been re-listed; activation fields follow the Subscriber state); a duplicate
  LIVE watch → `409 conflict`.
- `suppressions(email PK, reason, created_at)` — `reason ∈ 'bounce' | 'complaint'`.
  Decision (architect): a separate table keyed on the ADDRESS, not a subscriber column —
  suppression is a property of the address and must survive unsubscribe/re-subscribe, or
  hygiene resets on churn. Rows are PII retained deliberately past subscriber deletion
  (standard deliverability-suppression exception; keep the table tiny and never log it).
  Upsert on conflict (first reason wins is fine). Retain until an explicit Operator
  clearance; the 90-day terminal-data sweep must not touch this table.
- `push_subscriptions(id, subscriber_id FK cascade, endpoint UNIQUE, p256dh, auth,
created_at)` — one row per registered browser. `endpoint` is globally unique; upsert
  reassigns on conflict (§4). `p256dh`/`auth` are delivery credentials: treat like email —
  never log endpoint or keys (log opaque ids + counts). Cascade delete on unsubscribe. The
  notifier deletes a row when the push service says the subscription is gone (404/410).
- `class_state(class_key PK, last_status, last_open_seats, last_waitlist_open, updated_at,
source_fresh_until, display_name NULL, last_enrolled NULL, last_capacity NULL,
last_waitlisted NULL, last_waitlist_max NULL)`
  — `last_status` ∈ `open|waitlist|closed`; drives 0→>0 transition detection (FR-4) and
  dedupe (FR-5). NEITHER a `parser-broke` NOR a `class-gone` cycle overwrites this table
  (FR-6/FR-13); only a successful `SeatState` parse upserts. `updated_at` is exposed as
  `lastCheckedAt`; `source_fresh_until` is computed from `Age`/`Cache-Control` plus the
  two-minute target and drives `sourceStale`.
  The five trailing columns are the FR-25 dashboard observations and are ALL nullable —
  a row only exists after a successful parse, but any individual observation may be absent
  (optional markup) or out of the persisted bound. `display_name` is bounded to 1–256
  characters and is display-only: never an identity, a lookup key, or part of a `ClassKey`.
  The worker carries all five on BOTH write paths (FR-26): a successful 200 whose optional
  markup disappeared CLEARS them to null, while a trusted 304 PRESERVES the prior
  observation — observed-absent and not-observed must not collapse into one value. Note
  `last_waitlist_open` is NOT NULL while `last_waitlisted`/`last_waitlist_max` are nullable,
  so a divergent snapshot is representable; consumers treat `last_waitlist_open` as
  authoritative for "the waitlist is moving" and MUST NOT report open waitlist spots when it
  is false (AC-33).
- `parser_health(class_key PK, status, episode_started_at NULL, alert_enqueued_at NULL,
recovered_at NULL, updated_at)` — `status ∈ healthy|broken`. A parser-broke result takes a
  row lock; only `healthy`/absent → `broken` may transactionally enqueue one Operator job.
  Repeated broken results are no-ops regardless of elapsed time or process. Only a
  successful parse transitions `broken` → `healthy`; this durable state makes FR-14 hold
  across restart/failover. A class-gone result does not masquerade as recovery.
- `mail_outbox(id PK, kind, subscriber_id NULL, class_key NULL, opened_at NULL, reason
NULL, status, attempts, available_at, expires_at NULL, claimed_at NULL, sent_at NULL,
terminal_at NULL, provider_idempotency_key UNIQUE, payload, created_at)` — the durable
  queue for Confirmation, Manage-link, Alert, and Operator mail (FR-17). `status ∈
queued|processing|sent|cancelled|dead_letter`; `payload` contains bounded template
  metadata only, never an email, token, raw HTML, or provider secret. Alert jobs have a
  unique `(subscriber_id, class_key, opened_at)` logical key and `expires_at =
opened_at + 1 hour`. Enqueue happens in the same transaction as the state change that
  requires mail. A claim uses a lease / `FOR UPDATE SKIP LOCKED`; the dispatcher retries
  the SAME provider idempotency key and marks success only after acceptance. One job maps
  to one provider request—never a provider batch. The token/link for retries is
  deterministic from `opened_at` for Alerts and `created_at` for Confirmation/Manage-link
  work, so retrying a provider idempotency key never changes the rendered payload. This is
  at-least-once, not exactly-once. A referenced dead-letter job is retained until its
  incident is resolved, then becomes eligible for the 90-day terminal purge.
- `dead_letter_incidents(id PK, mail_job_id UNIQUE FK, state, opened_at, surfaced_at NULL,
acknowledged_at NULL, resolved_at NULL)` — `state ∈ unresolved|acknowledged|resolved`.
  The first dead-letter transition creates exactly one row atomically. A production
  incident publisher exports one logical event with idempotency key
  `dead-letter/<incident-id>` and stamps `surfaced_at` only after acceptance; retries reuse
  that key. The sink is operational/out-of-band, not another `mail_outbox` job. Operator
  acknowledgement and resolution are explicit authenticated CLI/runbook actions. Only
  `unresolved` rows fail readiness; acknowledge means the Operator intentionally owns the
  incident, while resolve means remediation/replay is complete. Neither a retry nor a
  successful replay changes incident state automatically.
- Retired Watches purge after 90 days; a `class_state` row with no live/retained Watch or
  mail reference purges in the same sweep. Suppression rows are exempt from timed purge.
- Repo surface consumed across lanes (db owns the implementations): fan-out
  `getSubscribersWatching(classKey)` returns CONFIRMED subscribers with a LIVE watch only;
  `getDistinctWatchedClassKeys()` returns keys with ≥1 live watch **held by a CONFIRMED
  subscriber** (v0.3.3 — Pending-only or fully-retired demand must not drive fetches:
  unauthenticated subscribes were an unbounded scrape-amplification primitive);
  `confirmSubscriber(id, capacity)` atomically returns
  `confirmed | already_confirmed | capacity_exceeded`; it checks already-Confirmed first,
  locks the shared capacity decision, and never partially activates. Capacity counts the
  union of live, activated Sections held by Confirmed Subscribers, so two concurrent
  confirmations cannot oversubscribe and an already-demanded Section adds zero.
  `retireWatchesForClass(classKey)`,
  `isSuppressed(email)` / `suppressEmail(email, reason)`, and push-subscription
  upsert/delete/list-by-subscriber. Subscriber creation additionally accepts a
  server-decided atomic max-current-Subscriber constraint (`null` outside pilot, `100` in
  pilot); the repository never receives the invite secret.
- The store (emails + watch lists + push endpoints/keys) is SENSITIVE (constitution).
  Never log its rows.

## 6. Non-functional requirements

- Performance: after a changed representation becomes observable from the public source,
  fetch→durable-email-acceptance p95 is under 120 seconds. This is explicitly NOT an
  SIS-event SLO. One fetch per unique class per eligible source cycle regardless of
  subscriber count. The source scheduler is never blocked on outbox drain/provider I/O;
  the concurrent dispatcher has its own bounded concurrency/timeouts and cannot hold the
  source lease or a database transaction while awaiting a provider. Push dispatch runs
  after-or-parallel to email and never delays it (FR-15/FR-23).
- Cadence/capacity (owner-selected option A, 2026-07-27): scheduling is deadline-driven
  by `Age`/`Cache-Control`, conditional validators, backoff, and bounded jitter; there is
  no promise of a fixed per-Section interval.
  `SOURCE_REQUESTS_PER_SECOND=1` is the strict application-wide ceiling: at least one
  second separates physical request permits to the Berkeley origin across every
  worker/process and every Subscriber/Section. Robots, class-page, conditional, and
  redirect attempts share it. Cache-fresh Sections issue no request, so one/second is a
  maximum rather than a traffic target. The limiter owns the callback that synchronously
  invokes each physical fetch start. It computes a conservative future reservation at
  least `max(now + spacing, prior lastPermitAt + spacing, active notBefore)`, atomically
  persists it before the reservation wait or invocation, then rechecks abort,
  kill-switch, and safety state at the start boundary. A reservation-write failure starts
  no request, retains the fence, and forbids normal handoff. After a successful durable
  reservation, a graceful abort, kill-switch, or safety interruption before invocation
  starts no request and may release the exclusive fence normally; it never rolls the
  reservation back, so a later owner still waits through that boundary and cannot start
  early. That normal release does not itself require Operator reset, although any
  independently engaged safety-stop marker retains its reset requirements. After the
  wait, the limiter synchronously invokes the fetch callback, records that actual
  invocation boundary, and reconciles `lastPermitAt` to no earlier than the actual start
  before normally releasing the exclusive fence to another owner. No normal handoff may
  occur if reconciliation fails; the fence is retained and source access fails closed.
  Thus an async gap outside the limiter, a process crash before/after invocation, or
  restart cannot compress request-start spacing. A nonempty non-finite/non-positive value
  or any value above 1 fails worker configuration.
  `SOURCE_VISIBLE_TARGET_SECONDS=120` remains the notification target after a page change
  is observable. Supported unique Sections =
  floor(0.8 × 1 source request/second × 120 seconds) = 96. The 20% reserve covers robots
  checks, redirects, jitter/backoff, cache variance, and operating headroom; conditional
  requests still consume physical permits and reuse ETag/Last-Modified when present.
  Cache-busting query parameters are prohibited. Capacity demand is the distinct set of
  activated live Sections held by Confirmed Subscribers; Pending staged Watches reserve
  zero. The pilot must measure actual source-visible p95 and request mix at this ceiling;
  if the 120-second target is not sustained, admission/capacity is reduced rather than
  exceeding one physical request/second.
  This numeric rate/target/capacity decision is closed. Raising the rate above 1 or the
  96-Section maximum requires a new owner decision and spec revision. The tracked
  `KILL_SWITCH=1` remains solely because live-source canary, current robots evaluation,
  contactable User-Agent, deployment configuration, and the other rollout gates are
  separate and still open.
- Source-use posture (owner decision, 2026-07-27): the only v1 source is public and
  unauthenticated, but affirmative permission for recurring automated access is
  unconfirmed. The owner accepts that uncertainty and may launch without written
  permission; the product and its documentation must not claim Berkeley authorization,
  endorsement, affiliation, or a guarantee against blocking or other consequences.
  Launch instead requires evidence that a current robots evaluation does not disallow the
  exact class-page path and that the controls in FR-3/FR-7 are active: one centralized
  deduplicated poller, cache-aware conditional requests, monitored contactable
  User-Agent, bounded global ceiling, jitter/backoff, and tested source safety-stop /
  kill-switch operation. This is a product risk decision, not legal advice or legal
  clearance; the owner remains responsible for reviewing applicable requirements.
- Durable source-safety state (FR-7): the production runtime volume stores a bounded
  safety marker, backward-readable origin-state v2, and an exclusive origin fence; none
  contains a URL, ClassKey, subscriber data, response content, or provider-controlled
  text. Origin state contains `lastPermitAt` plus a bounded canonical
  `notBefore`/`notBeforeSetAt` pair. A 429 marker contains only its fixed reason,
  `stoppedAt`, and `resumeNotBefore`; both persisted deadlines incorporate the bounded
  upstream `Retry-After` and are capped at 24 hours. The reset CLI requires exact
  `KILL_SWITCH=1` plus the explicit confirmation phrase and refuses while the marker's
  `resumeNotBefore` is in the future, including after worker restart/recreation, with
  fixed non-PII classification `resume_deadline_active`. Once eligible, reset atomically
  sets a valid `lastPermitAt` to `max(existing lastPermitAt, reset time)` before clearing
  the fence: it advances an older boundary to at least reset time and never moves a future
  reservation/start boundary backward. Any valid later `notBefore`/`notBeforeSetAt`
  cooldown is preserved. If origin state is missing, malformed, or unreadable, reset must
  atomically write a valid last-permit timestamp equal to reset time before clearing the
  fence, so the next permit still waits the full configured spacing. If either the
  monotonic update or repair cannot be persisted, reset exits nonzero and source remains
  stopped. If either 429 cooldown persistence path fails, the retained fence remains
  fail-closed; if both fail, eligibility is unknown and recovery requires explicit review
  plus a conservative wait before reset. Container recreation preserves the named
  volume; volume deletion/pruning or host loss does not, so deployment configuration
  independently retains `KILL_SWITCH=1` throughout recovery.
- Robots posture (D9, RFC 9309): robots.txt fetch 404 → crawling allowed; 5xx/unreachable
  → treat as disallowed and SKIP fetching that cycle (no more fail-open). robots.txt is
  fetched once and cached per poll cycle (TTL = one interval), not per class. ADR 0002
  records only a historical observation (2026-06-09) that the exact path was not
  disallowed; this is not proof of current policy and must not be treated as
  authorization. A current disallow engages the FR-7 source-safety stop. A
  5xx/unreachable robots result remains fail-closed for that cycle.
- Security/authz: no passwords; token links are signed + expiring + per-subscriber and
  travel ONLY by email. Double opt-in gates all alerting (FR-9); confirmation requires an
  explicit POST so scanner prefetch cannot confirm (§4). Webhook ingress is
  signature-verified (FR-12). Secrets (mail/webhook/VAPID) from env only. Untrusted-HTML
  handling per constitution. Pilot admission uses a shared bearer—not an authentication
  claim—and compares SHA-256 digests with a timing-safe primitive. The raw code never
  reaches the database, mail queue, structured logs, metrics, traces, error reporting, or
  response. Tiny PII surface (emails, watch lists, suppression rows, push endpoints/keys —
  nothing more).
- Required env (fail-loud rule): with `MAIL_TRANSPORT=noop` (dev/test/CI only) nothing extra is
  required; optional `NOOP_OUTBOX_FILE` (v0.3.1; default unset; honored ONLY when the
  transport is noop) appends each outbox entry as NDJSON to that path for black-box
  verification; it contains PII + tokens by design. `NODE_ENV=production` MUST fail
  startup before serving/claiming work unless `MAIL_TRANSPORT=real`,
  `MAIL_PROVIDER=resend`, and `NOOP_OUTBOX_FILE` is unset/empty. Production must also
  validate every required real-mail value (`MAIL_FROM`, `RESEND_API_KEY`,
  `RESEND_WEBHOOK_SECRET`, and those below); noop fallback is forbidden. For ANY
  non-noop transport, startup MUST fail loudly if `OPERATOR_EMAIL`
  (FR-14) or `APP_BASE_URL` (emailed links, §4) is unset, or if `TOKEN_SECRET` is
  missing/short (min 32 chars) — any process serving a real mail transport (worker
  included) MUST refuse to start, else alert emails ship without the manage link and the
  RFC 8058 `List-Unsubscribe` header (v0.3.2); with `MAIL_PROVIDER=resend`,
  also `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` (else suppression silently never
  happens). `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` are optional — unset
  disables push (public-key route returns `null`). Rate limits:
  `RATE_LIMIT_SUBSCRIBE_MAX`/`RATE_LIMIT_WINDOW_SECONDS` (per-IP, default 5/60s) and
  `RATE_LIMIT_EMAIL_MAX`/`RATE_LIMIT_EMAIL_WINDOW_SECONDS` (per-email, default 3/900s),
  applied to subscribe AND resend using atomic Redis operations shared across processes.
  `TRUST_PROXY` gates forwarded addresses. Production requires `TRUST_PROXY=1` plus a
  distinct high-entropy `PROXY_HEADER_SECRET` (32–256 unpadded-base64url characters);
  Caddy and API share it through env, Caddy overwrites
  `x-seat-sniper-proxy-secret`, and the application uses a timing-safe comparison before
  trusting Caddy-overwritten `X-Forwarded-For`. The proxy secret is not interchangeable
  with `PILOT_INVITE_CODE` and is never logged. Missing/invalid production proxy config
  fails startup; in standalone development `TRUST_PROXY=0` ignores forwarded headers.
  Admission is separately fail-closed in EVERY environment:
  `ADMISSION_MODE=closed|pilot|public` defaults to `closed`; any other value fails startup.
  `pilot` requires `PILOT_INVITE_CODE` to be a high-entropy 32–256-character unpadded-
  base64url secret or startup fails. `closed` and `public` neither require nor consult it.
  The committed production/default environment template says `ADMISSION_MODE=closed`;
  local/CI verification that creates subscribers must opt into `public` explicitly or
  supply the pilot code. The code uses only `A–Z a–z 0–9 _ -`, making character and UTF-8
  byte bounds identical. No env exposes a pilot limit above the contract's fixed 100
  current rows. Production additionally requires `BACKUP_SUCCESS_MARKER_FILE` to name the
  shared read-only marker mounted into the API and `BACKUP_MAX_STALE_SECONDS` (default
  5400, greater than the hourly backup interval); missing config fails startup and
  missing/stale/malformed marker content fails readiness.
- Deliverability hygiene (D4/D5, plan 0008): every subscriber-facing email carries
  `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` targeting the
  one-click route (§4). Suppression is checked before EVERY subscriber-facing send.
  Alert-email copy includes the reserved-seat caveat (ADR 0006 mitigation): some open
  seats are reserved for specific groups and may not be enrollable by everyone.
- Operator alerting (D7): destination is the monitored `OPERATOR_EMAIL` inbox; required +
  fail-loud per the env rule. Parser-broke episode state is durable (§5): one alert until
  a successful parse records recovery, including across restart/failover. Cooldown
  re-alerting is forbidden and `OPERATOR_ALERT_COOLDOWN_SECONDS` is removed/unsupported.
  Operator mail is exempt from suppression checks.
- Accessibility: dashboard meets WCAG 2.1 AA on the subscribe/confirm/manage flows
  (labels, keyboard operability, visible focus; the push toggle and resend form included).
- Observability: structured logs with opaque ids/counts only (no emails, no full watch
  lists, no push endpoints/keys, no tokens, no invite query/header/body). Edge/runtime logs
  remove request URI and headers. Webhook logs are restricted to the fixed
  classifications in §4; no provider-controlled string or raw exception text is emitted.
  Metrics: fetch latency, parse failures, class-gone
  retirements, alerts sent (email/push), push failures, dedupe suppressions,
  suppressed-address skips, operator episodes opened/recovered, rate-limit rejections,
  and aggregate admission denials without labels that reveal mode/code validity/count.
- Delivery durability & robustness (v0.4 — each rule
  binds the named lane):
  - Durable at-least-once (FR-4/FR-17): all mail dispatch runs through `mail_outbox`
    (§5). A dispatch failure must NOT be masked by the `class_state` upsert. Reuse a
    deterministic provider idempotency key; accept that the accept→mark crash window can
    rarely duplicate. Cancel a queued Alert once its opening closes; expire it at one
    hour. Other mail stops retrying before the provider's 24-hour idempotency horizon and
    dead-letters for operator action / subscriber resend. Send each durable job
    individually: provider batching is prohibited because claim-batch membership changes
    across retries. A retried job re-renders byte-identically; token issue time comes from
    its durable timestamp (`opened_at` for Alert, `created_at` otherwise), not dispatch
    wall time. (worker+db+notify)
  - Dispatcher isolation (FR-23): the source scheduler and mail dispatcher are independent
    concurrent loops. Outbox claims are bounded and transactions finish before network
    I/O; provider requests use bounded concurrency/timeouts. The source loop never awaits
    an outbox batch and retains a database/lease execution budget even under backlog.
    (worker+db+notify)
  - Dead-letter lifecycle (FR-22): the dead-letter transition and its unique incident row
    commit together. An out-of-band publisher/monitor uses the incident id as its
    idempotency key; it never creates mail-outbox work. Explicit Operator acknowledge or
    resolve is required, and only `unresolved` is an aggregate-readiness failure. This
    rule applies to `operator` jobs too, without recursively creating alerts.
    (worker+db+infra)
  - Baseline staleness: if the prior `class_state.source_fresh_until` has passed because a
    class left/re-entered demand or the worker was down, the next successful parse
    REBASELINES — state is upserted, no alert fires. A stale baseline must never
    manufacture an "opening" that happened while nobody was watching. (worker)
  - Suppression posture (FR-12): the dispatch-time suppression lookup fails CLOSED for
    that attempt: leave the outbox job retryable and log `suppression_check_failed`; never
    send while suppression status is unknown.
    The WEBHOOK persist path is the opposite: a failure to record a suppression returns
    5xx so the provider retries — never 204-and-lost. (notify/server)
  - Extended fail-loud env: the SERVER (not only the worker) probes `mintToken` at boot
    under any non-noop transport (a missing `TOKEN_SECRET` must not create Pending rows
    whose confirmation can never be minted). `DATABASE_URL` is REQUIRED (fail-loud) when
    `NODE_ENV=production` or the transport is non-noop — the in-process PGlite fallback
    is dev/test-only and is per-process (API and worker would silently see different
    databases). VAPID config is all-or-nothing: a partial set fails startup; the
    public-key route returns a key only when push is actually operational. A configured
    SMTP transport validates its required config at construction, not first send.
    (server/worker/notify)
  - Outbox retention: the in-memory outbox + NDJSON sink record ONLY under the branded
    noop transport; real transports retain nothing (no PII/token accumulation in
    production memory). Delivery-dedupe state must be bounded (`mail_outbox` is the
    durable record and terminal rows purge per FR-18). (notify)
  - Entrypoint env loading: server and worker entrypoints best-effort load `./.env`
    (`process.loadEnvFile`) before reading config, so the documented copy-env flow is
    real. (server/worker)
  - Send robustness: every outbound send (Resend HTTP, web push) carries an explicit
    timeout; fan-out uses bounded concurrency; one hanging subscriber send must never
    stall the cycle or later subscribers' email. Scraper fetches bound BODY read time,
    robots fetches carry the same timeout. Transient network/5xx failures THROW to the
    scheduler so exponential backoff engages; a class-page 403/429 instead triggers the
    FR-7 source-safety stop. None of these failures is `parser-broke`.
    (notify/worker/scraper)
  - Robots correctness: honor `Allow` with longest-match precedence and `*`/`$` wildcards
    per RFC 9309 (a site-wide `Disallow: /` + `Allow: /content/` must permit class
    pages). (scraper)
  - Public-page parser (FR-6/FR-16): parse exactly one labeled `Total Open Seats`, one
    `Waitlisted`, and one `Waitlist Max` from the enrollment section. Open seats accepts a
    signed plain integer and normalizes values ≤0 to zero with telemetry; waitlist is open
    iff max > 0 and current < max. Missing, duplicate, non-integer, or contradictory fields
    are `parser-broke`, never a guessed state. Verify the page's canonical identity equals
    the requested `ClassKey`. Follow at most three redirects, HTTPS only, remaining on the
    exact `classes.berkeley.edu` origin. (scraper)
  - Push registration hardening (FR-15): endpoint is https-only (contract), at most 5
    push subscriptions per subscriber (409 beyond), the enable route shares the per-IP
    rate limit, disable deletes only rows OWNED by the authenticated subscriber, and
    partial-VAPID states are impossible (see fail-loud above). (server/db)
- Production topology: one VPS runs Caddy (the only public port), API, exactly one
  lease-owning worker, PostgreSQL, and Redis on private container networks. Migrations are
  a one-shot release step, not an app-start race. PostgreSQL has encrypted off-host
  backups (RPO 1 hour, RTO 4 hours) and a tested restore. After—and only after—an encrypted
  off-host snapshot succeeds, the backup service atomically replaces a bounded JSON marker
  in a named shared volume: `{ "completedAt": "<RFC3339 UTC>" }`. The API mounts that
  marker read-only at `BACKUP_SUCCESS_MARKER_FILE`. In production the aggregate readiness
  probe covers PostgreSQL, Redis, worker-cycle age/status, source freshness, unresolved
  dead letters, outbox backlog, disk, and this marker; missing, malformed, future-dated,
  or older than `BACKUP_MAX_STALE_SECONDS` is not-ready. Non-production may omit it.
  `/api/health` remains 200 while the process can serve, including under `KILL_SWITCH=1`;
  Caddy/container startup depends on liveness, while external operations monitoring
  consumes aggregate readiness.

## 7. Acceptance criteria (verifier runs these; each pass/fail; trace in brackets)

Verification universe: SAVED FIXTURES (`src/scraper/fixtures/**`), `MAIL_TRANSPORT=noop`
outbox, the fake push transport, fake-signed webhook payloads, and ephemeral real
PostgreSQL/Redis/Compose services. CI performs no Berkeley or real-mail request.
Confirm/manage links are extracted from outbox bodies (§4 pinned format). An
owner-controlled live-source and real-inbox canary is a separate release gate. Existing
subscriber-flow fixtures explicitly set `ADMISSION_MODE=public`; that is a test setting,
not a production default. Admission-specific tests exercise all three modes separately.

- AC-1 [FR-1, FR-2, FR-9]: Subscribing with a normalized `@berkeley.edu` email + class URL returns
  `202 { status: 'pending' }` whose body contains NO token and NO subscriberId; the UI
  shows "check your inbox"; the noop outbox gains one `confirmation` entry to that address
  containing the confirm link. Extracting the link's token and performing the confirm
  action returns `200 { status: 'confirmed' }`, after which the manage view fetched with
  that same token shows `confirmed: true` and lists the watch.
- AC-2 [FR-1]: Subscriber validation accepts case/whitespace-normalized exact
  base `@berkeley.edu` addresses; it rejects `name+tag@berkeley.edu`, other domains,
  Berkeley subdomains, lookalike suffixes, malformed email, or an unrecognizable class
  identifier. Repeating with `name@berkeley.edu` passes email validation, proving the base
  address remains usable. The UI shows an inline error and creates no row for rejection.
- AC-2b [FR-1, §6 authz]: Creating with an email that already has a subscription returns
  `409 conflict` with the constant-shaped `{ error }` envelope only — no manage token, no
  `subscriberId`, no watch list — and the existing subscription is unchanged (no merge).
- AC-3 [FR-3, FR-4, FR-9]: Against a SAVED FIXTURE that flips 0 → >0 open seats, every
  CONFIRMED subscriber of that class gets exactly one `alert` outbox entry.
- AC-4 [FR-4, FR-5]: A second poll with seats still >0 produces NO new notification
  (dedupe).
- AC-5 [FR-6]: A 200-but-shape-changed fixture produces a "parser-broke" operator alert
  and zero subscriber notifications, and does not overwrite `class_state`.
- AC-6 [FR-7, FR-21]: (a) With `KILL_SWITCH=1`, missing, empty, malformed, or any value
  other than exact `0`, a poll cycle performs no outbound fetch, liveness remains 200,
  source/aggregate readiness is `disabled` / 503, outbox/retention work continues, and
  existing confirm/manage/unsubscribe ingress remains usable.
  (b) A current robots disallow for the exact content path, or a class-page 403 or 429,
  aborts all remaining origin work in that cycle, engages the source-safety stop, and
  performs no later class-page fetch until explicit Operator reset. The tested runbook
  puts `KILL_SWITCH=1` immediately for an observed operational-harm signal. A 429's
  bounded, non-PII marker persists a `resumeNotBefore` at least as late as the effective
  worker cooldown / bounded origin `Retry-After`, and origin-state v2 persists its
  bounded `notBefore` before marker engagement. Restart and an otherwise-valid reset
  before the effective deadline remain stopped; an early marker reset emits fixed CLI
  classification `resume_deadline_active`. Permit eligibility is the later of last-permit
  spacing and `notBefore`. (c) An eligible reset under exact `KILL_SWITCH=1` atomically
  advances valid origin `lastPermitAt` to `max(existing lastPermitAt, reset time)` while
  preserving a later valid cooldown; it never moves either boundary backward.
  Missing/malformed/unreadable state is reinitialized to reset time before the stale fence
  clears only when the repair can be atomically persisted; otherwise reset exits nonzero
  and remains stopped. A failure of either persistence path retains the fence, and the
  dual-failure case requires explicit Operator review and a conservative wait because
  eligibility is unknown. The runbook verifies the marker/fence, monotonic origin
  timestamps, disabled state, and full-spacing/cooldown posture before exact
  `KILL_SWITCH=0` may be considered.
- AC-7 [FR-2, FR-4]: Unsubscribe via the token — the DELETE route or the RFC 8058
  one-click POST route — removes the subscriber; a later opening sends them nothing.
- AC-8 [§6 observability]: No subscriber email, full watch list, token, or push
  endpoint/key appears in any log line (webhook + suppression + push paths included).
- AC-9 [FR-9]: Two subscribers watch the same class, one Pending and one Confirmed; a
  0→>0 fixture flip delivers exactly one alert — to the Confirmed one. The Pending
  subscriber's address appears in no alert outbox entry.
- AC-10 [FR-9]: Calling confirm twice with the same token returns `200
{ status: 'confirmed' }` both times, the subscriber's confirmation timestamp is set
  exactly once, every Watch activates once, and no additional email is sent by the second
  call. The second call remains 200 even if capacity was subsequently reduced below
  demand.
- AC-11 [FR-10]: Resend for a subscribed address and for an unknown address both return
  byte-identical `202 { status: 'sent' }` bodies; the outbox gains exactly one entry for
  the subscribed address (confirmation if Pending, manage-link if Confirmed) and none for
  the unknown one. If the durable lookup/enqueue repository operation throws, known,
  unknown, and suppressed requests return the byte-identical generic
  `500 internal_error`; a known request with a rolled-back/failed enqueue never returns 202.
- AC-12 [FR-11]: Exceeding the per-email window on resend (and the per-IP window on
  subscribe) returns `429 rate_limited` in the standard envelope; under-limit requests
  still succeed.
- AC-13 [FR-12]: (a) A correctly fake-signed hard-bounce (and separately a complaint)
  webhook payload for an address returns 204 and suppresses it: a later opening of a class
  that suppressed-but-Confirmed subscriber watches delivers NOTHING to that address while
  other subscribers still get their alert, and subsequent confirmation/manage-link sends
  to it are also withheld (resend still returns 202). (b) The same payload with a bad
  signature returns `401 signature_invalid` and suppresses nothing.
  (c) A 32,768-byte raw body reaches signature handling; a 32,769-byte body—with good,
  bad, or missing signature headers—returns canonical 413 first. Captured logs contain
  only a §4 fixed classification and no raw/body/header/provider-controlled value.
- AC-14 [FR-13]: Against a 404/not-found fixture for a watched class: every watch on it is
  retired (the manage view no longer lists it; the next cycle does not fetch it), NO
  operator alert and NO subscriber alert is sent, and the class's `class_state` row is
  unchanged. Re-adding the class from the manage view revives the watch (200, listed
  again).
- AC-15 [FR-14]: (a) A class that stays parser-broke across ≥3 consecutive poll cycles
  and beyond the former cooldown produces exactly ONE operator outbox entry, including
  across worker restart and lease failover; after a clean-parse recovery cycle (logged),
  the next break produces exactly one more. (b) With a non-noop transport configured and
  `OPERATOR_EMAIL` unset, startup fails loudly (test via construction, no real send).
- AC-16 [FR-15]: (a) A Confirmed subscriber registers a push endpoint (201); on the next
  genuine opening the fake push transport records exactly one payload for that endpoint
  matching `PushAlertPayload` (classKey + reason present; NO token, NO confirm/manage URL
  anywhere in it). (b) When the push transport throws, the email alert is still delivered
  (outbox entry present) and the cycle completes. (c) A Pending subscriber's push
  registration attempt returns `409 conflict`.
- AC-17 [FR-1, FR-6]: Canonical and human/URL forms for numeric IDs plus real shapes
  `999l`, `col`, `grp`, `slf`, and `tut` normalize to one bounded `ClassKey`; malformed or
  overlong segments fail. Live-shaped saved fixtures parse labeled open/waitlist counts,
  normalize negative open seats to zero, and classify missing/duplicate/contradictory
  fields or page-identity mismatch as `parser-broke`.
- AC-18 [FR-3, FR-16]: Cache metadata defers a refetch until eligible and conditional
  validators are reused. The manage response returns one same-order `watchFreshness`
  entry per Watch; never-observed/overdue sources are stale. The test fetch-start callback
  proves physical robots, class-page, conditional, and redirect starts from all
  workers/Sections are globally spaced at least one second apart. It also injects a
  reservation-write failure and a reconciliation-write failure after actual start: each
  retains the fence and forbids normal handoff. A crash after durable pre-start
  reservation performs no normal handoff, and recovery still honors that future boundary.
  Separately, a graceful abort, kill-switch, or safety interruption during the reserved
  wait invokes no fetch and may release the fence normally without Operator reset solely
  for that release, but the durable reservation remains and prevents an early next start.
  Reset evidence proves an older valid last-permit boundary advances to reset time, a
  future boundary and later cooldown never move backward, and a failed monotonic write
  leaves the fence/source stopped. At `SOURCE_REQUESTS_PER_SECOND=1` and
  `SOURCE_VISIBLE_TARGET_SECONDS=120`, any number of Pending staged Watches consumes zero
  of 96 slots and create/add succeeds. A Pending confirmation or Confirmed add that would
  activate the 97th unique Section is atomically rejected with `503 capacity_exceeded`
  plus `Retry-After`, remains wholly Pending/unactivated where applicable, and can later
  be retried with the same token. Confirming/adding an already-demanded Section succeeds
  at the ceiling. Concurrent confirmations never let confirmed unique demand exceed 96.
- AC-19 [FR-4, FR-17]: Inject crashes before claim, after claim, after provider acceptance,
  and before success marking. Every Alert remains queued or reaches provider acceptance;
  retries reuse one idempotency key, and only the documented accept→mark window may
  duplicate. A closing Section cancels its queued Alert; an unsent Alert older than one
  hour dead-letters/cancels and is never delivered. Multiple claimed jobs produce one
  provider request each (no provider batch); retrying each uses byte-identical subject,
  body, and headers because Alert links derive from `opened_at` and other links derive from
  outbox `created_at`. Resend 429 honors `Retry-After`.
- AC-20 [FR-17, FR-18]: Confirmation creation and its mail job commit or roll back
  together; production jobs contain no denormalized recipient/token. A retention sweep
  deletes 72-hour Pending accounts and eligible 90-day terminal jobs/retired state, while
  preserving Confirmed accounts, suppression rows, and jobs referenced by unresolved or
  acknowledged dead-letter incidents.
- AC-21 [§4]: Every body route rejects a payload above its bound before JSON parsing with
  canonical `413 payload_too_large`; malformed smaller JSON remains `400 validation_error`.
  The webhook specifically proves the exact 32,768/32,769-byte boundary and size-before-
  signature precedence.
- AC-22 [FR-11, FR-20]: Two API instances sharing Redis enforce one atomic IP/email
  window. Restarting either instance does not reset limits. A request from a private peer
  with spoofed forwarded headers but no/wrong proxy secret is keyed by the peer; only
  Caddy's overwritten, timing-safe-authenticated header makes its overwritten client IP
  trusted, and neither secret nor forwarded raw value appears in logs.
- AC-23 [§5/§6, FR-21]: Fresh and upgrade migrations pass on real PostgreSQL; two workers prove
  one active advisory lease and clean failover. The production Compose topology exposes
  only Caddy, gates Caddy/API startup on liveness, and reports PostgreSQL/Redis/worker/
  source/outbox/unresolved-dead-letter/disk/backup-marker aggregate readiness. A backup
  restore meets the declared RPO/RTO drill.
- AC-24 [rollout]: CONDITIONAL — this criterion defines the evidence bar that WOULD apply if
  public admission were ever enabled. Per the owner decision of 2026-07-30 (§2 Rollout
  posture) `public` is not a v1 destination, so AC-24 is not a v1 gate and its unmet items
  are not outstanding v1 work. The items that ARE v1 gates for the friends-only pilot are
  listed under "Rollout gates" (hard blockers + pilot), including the unassigned Operator
  inbox blocker. Should the decision be revisited, release evidence must include the dated
  owner risk-acceptance and
  one-global-request/second rate-decision records, a current robots evaluation that does
  not disallow the exact content path, deployed `SOURCE_REQUESTS_PER_SECOND=1` and
  `SOURCE_VISIBLE_TARGET_SECONDS=120`, a contactable identifying User-Agent, passing
  live-source and real-inbox canaries, authenticated SPF/DKIM/DMARC, monitored
  `OPERATOR_EMAIL`, successful restore, green strict security/integration/E2E gates,
  exercised source-safety-stop/kill-switch procedures, and measured source/outbox SLOs
  before public admission is enabled. The evidence does not claim Berkeley permission,
  authorization, endorsement, or legal clearance.
- AC-25 [FR-19]: With no admission env, and separately with `ADMISSION_MODE=closed`, create
  returns the canonical `503 admission_unavailable` + exact `Retry-After: 3600`, while an
  existing Subscriber can still resend, confirm, load/manage watches, change push, and
  unsubscribe. In `pilot`, missing/wrong/malformed/oversize bearer and the 101st concurrent
  current Subscriber return the byte-identical status/body/header; exactly 100 concurrent
  distinct creates can commit, counting Pending + Confirmed, and unsubscribe/72-hour purge
  releases a slot. The correct header admits a Pending exact-Berkeley mailbox; the invite
  is absent from database/outbox/logs/errors. In `public`, no header is required and
  exact-Berkeley requests still obey rate and unique-Section capacity. Invalid mode and
  pilot without a valid 32–256-character unpadded-base64url secret fail startup. The
  browser invite journey strips `?invite=` immediately, stores it only in sessionStorage,
  sends only the pinned header, and clears it after 202.
- AC-26 [FR-8, §6 env]: Every production entrypoint rejects `MAIL_TRANSPORT=noop`, a
  non-empty `NOOP_OUTBOX_FILE`, missing/invalid real-mail config, `TRUST_PROXY!=1`, or
  missing/invalid `PROXY_HEADER_SECRET` before serving or claiming work. Equivalent
  dev/test noop config remains valid.
- AC-27 [FR-22]: For each job first dead-lettered, exactly one incident and one logical
  externally published idempotency key exist. Reprocessing does not resolve it;
  `unresolved` fails readiness, `acknowledged` and `resolved` do not, and the referenced
  job is retained until resolution. Dead-lettering an `operator` job produces no
  additional mail job or recursive alert.
- AC-28 [FR-23]: With provider sends blocked beyond one source interval and an outbox
  backlog larger than one claim batch, virtual-clock/integration evidence shows eligible
  source fetches and lease heartbeats remain on schedule; no source-cycle path awaits the
  dispatcher and provider concurrency remains bounded.
- AC-29 [FR-21]: `KILL_SWITCH=1`, stale source, or an unresolved dead letter makes
  aggregate readiness 503 without changing liveness or removing existing subscriber
  ingress; Compose/Caddy remains started and reachable for recovery.
- AC-30 [FR-21]: In production, absent, malformed, future-dated, or stale
  `BACKUP_SUCCESS_MARKER_FILE` makes aggregate readiness 503. An atomic marker written
  only after successful encrypted off-host backup restores readiness, and the API mount
  is read-only. Non-production can omit the marker.
- AC-31 [FR-24]: A Confirmed Subscriber holding 4 LIVE Watches who adds a fifth receives
  `409 watch_limit_reached` — a canonical code distinct from `conflict` — with no
  `Retry-After`, and their 4 Watches are unchanged. After removing one, the same add
  succeeds. Independently, `POST /api/subscriptions` carrying 5 `classKeys` is rejected
  `400 validation_error` and NO Subscriber row, staged Watch, or confirmation job is
  created. Adding a class the Subscriber already watches still returns `409 conflict`, so
  the two conditions remain distinguishable by `error.code`.
- AC-32 [FR-24, FR-13]: Retirement frees a slot — a Subscriber at the cap whose Section is
  retired (class-gone) can add a new class without removing anything. Reviving a retired
  Watch while 4 LIVE Watches already exist is refused with `409 watch_limit_reached`, not
  `conflict`. A Pending Subscriber is capped identically. When a Subscriber is at the cap
  AND the requested Section would also exceed unique-Section capacity, the response is
  `watch_limit_reached`, not `capacity_exceeded`.
- AC-33 [FR-25]: The manage response carries one `watchFreshness` entry per LIVE Watch,
  each with all seven observation keys present. A Watch whose Section has never been polled
  returns `null` for all seven and the view renders a dash for each without error. For any
  single snapshot a rendered open-waitlist count > 0 IMPLIES `waitlistOpen` is true. The
  converse is NOT asserted and must not be tested as one: `waitlistOpen` true with null counts
  renders a dash, and `waitlistOpen` null renders a dash whatever the counts say — reachable for
  rows migrated before the observation columns existed. `waitlistOpen` false renders 0. With the
  saved fixture (Waitlisted 100 / Waitlist Max 100) the box renders 0 open waitlist slots
  out of 100, never 100 of 100. The official class URL is derived from `classKey` alone.
- AC-34 [FR-26]: A fixture whose page omits the display heading, `Enrolled`, or `Capacity`
  still parses to a `SeatState` with those fields null and NEVER yields `parser-broke`, and
  that cycle's Subscriber alerts are unaffected. Removing `Total Open Seats`, `Waitlisted`,
  or `Waitlist Max` still yields `parser-broke` (FR-6 unchanged). A successful 200 whose
  optional markup disappeared clears those stored values to null, while a 304 leaves the
  prior observation intact.

### Rollout gates

- **Hard blockers:** written or affirmative Berkeley permission is not a launch
  prerequisite; permission for recurring automated access remains unconfirmed and the
  owner explicitly accepts that risk. The rate blocker is closed at one physical
  Berkeley-origin request/second globally, a 120-second source-visible target, and 96
  unique Confirmed-demand Sections. Before live polling, verify those exact deployed
  values, record a current robots evaluation that does not disallow the exact content
  path, record the monitored contact in the identifying User-Agent, and successfully
  exercise the FR-7 source-safety stop / kill switch. A robots disallow,
  403, 429, direct stop request, or observed operational harm stops source fetching
  immediately; admission remains `closed` until Operator review and reset. Production
  also requires controlled domain/DNS, TLS, Resend quota, SPF/DKIM/DMARC, webhook secret,
  and a monitored Operator inbox. Admission remains `closed` while any blocker is open.
- **Pilot:** run the production-grade flow for at least two weeks, capped at 100 accounts
  and 96 unique Sections under the selected one-request/second ceiling. Measure physical
  request mix (including robots/redirect overhead), cache behavior, and source-visible
  p95; reduce admission/capacity if the 120-second target is not sustained. Set
  `ADMISSION_MODE=pilot`, privately share the bearer journey, and verify the atomic
  account cap. No pilot bypasses double opt-in, suppression, or durability.
- **Public: NOT a v1 goal (owner decision, 2026-07-30).** This service is local first, then
  friends-only by invitation. It is deliberately not a public service open to every Berkeley
  student, and `ADMISSION_MODE=public` is not a planned state for v1. The mode still exists
  in the code and its tests remain valid, but reaching it is out of scope; do not treat the
  gate chain below as pending work. Should that decision ever be revisited, the bar is:
  AC-1–AC-34 pass, the restore and live canaries pass, the two-minute source-visible SLO
  and mail backlog stay healthy across the pilot, complaints/bounces remain within the
  provider's healthy range, and rollback/kill-switch procedures have been exercised.
  Existing subscriber-flow fixtures that set `ADMISSION_MODE=public` remain a TEST setting
  and are not evidence of a public launch intent (§7 preamble).

**OPEN BLOCKER — pilot Operator inbox is UNASSIGNED.** `OPERATOR_EMAIL` is not a
notification preference; it is a required on-call address, and the application refuses to
boot with a real mail transport unless it is set. Two things route there and both need a
human inside a short window: a parser-break episode (FR-14) sends exactly ONE email and
never repeats until a later successful parse rearms it, so an unread alert means watchers on
that Section silently stop being notified; and a dead-letter incident (FR-22) opens a durable
`unresolved` incident that fails aggregate readiness until a human acknowledges or resolves
it. Alerts expire by design within the hour, so a break noticed the next morning means pilot
users got nothing. This blocker is explicitly UNRESOLVED and must not be read as satisfied by
any other gate above. It needs a named primary and a named backup on a mailbox with push
notifications, not a role alias. No pilot invitation goes out until it is assigned.

## 8. Task breakdown (dependencies & owners; teammate names per AGENTS.md in parens)

| #   | Task                                                                                                                                                        | Owner role                                  | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------- |
| 1   | Contract/spec v0.4.2, source/glossary, admission, activation-capacity, and production-safety decisions                                                      | architect                                   | —          |
| 2   | PostgreSQL migrations/repositories: Berkeley constraint, widened keys, source freshness, durable mail queue, cleanup, atomic pilot cap                      | database-engineer (db)                      | 1          |
| 3   | Public source: live-shaped parser, identity/redirect safety, RFC 9309, cache metadata, conditional fetch, fixtures                                          | scraper-engineer (scrape)                   | 1          |
| 4   | API: exact-domain boundary, fail-closed admission/header, 64 KiB limit, Redis limits, capacity admission, durable recovery enqueue, `watchFreshness`        | backend-engineer (api)                      | 1, 2       |
| 5   | Worker: cache-aware scheduler, source ceiling, advisory lease, outbox drain/cancel/dead-letter, retention sweeps                                            | worker-engineer (worker)                    | 1–3        |
| 6   | Notify: individual-job Resend throttling/idempotency, stable durable-time rendering, retry classification, fail-closed suppression, best-effort push        | notifier-engineer (notify)                  | 1, 2       |
| 7   | Minimal UI integration: Berkeley validation/copy, session-scoped pilot invite journey, freshness/capacity/error states, mirrored service-worker key grammar | frontend-engineer (ui)                      | 1, 4       |
| 8   | Single-VPS topology: Redis/private networks, one-shot migrations, backups, health/metrics, deploy/rollback                                                  | devops-engineer (infra)                     | 1, 2, 4–6  |
| 9   | Unit/integration coverage for FR-1–FR-26 and AC-1–AC-34, including activation/admission concurrency and real PostgreSQL/Redis lanes                         | test-engineer (test)                        | 2–6        |
| 10  | Browser journeys and production-like Compose smoke tests                                                                                                    | e2e-qa-engineer (e2e)                       | 7–9        |
| 11  | Independent security and code review                                                                                                                        | security-reviewer + code-reviewer (sec/rev) | 3–8        |
| 12  | Full gates, release evidence, AC-1–AC-34, then `.claude/acceptance.passed`                                                                                  | lead                                        | 9–11       |

Task 1 blocks implementation. Tasks 2 and 3 then run in parallel; 4 and 6 follow the DB
contract; 5 joins DB + source; 7/8 integrate; independent tests/reviews precede acceptance.

## 9. File-ownership map (no path owned twice)

- `specs/**`, `src/shared/**`, `CONTEXT.md`, `docs/**`, `README.md`, `RUNBOOK.md` →
  architect (contract read-only to all others; glossary/ADR/plan edits are architect-only)
- `src/db/**`, `drizzle/**` → database-engineer
- `src/server/**`, `src/api/**` → backend-engineer
- `src/client/**`, `src/components/**`, `index.html`, `public/**`, `vite.config.ts` →
  frontend-engineer (service worker + static assets included)
- `src/scraper/**` (incl. `src/scraper/fixtures/**`) → scraper-engineer
- `src/worker/**` → worker-engineer
- `src/notify/**` → notifier-engineer
- `tests/**`, `vitest.config.ts` → test-engineer
- `e2e/**`, `playwright.config.ts` → e2e-qa-engineer
- `Dockerfile`, `docker-compose*`, `Caddyfile`, `.github/**`, `.dockerignore`,
  `env.example` → devops-engineer
- `scripts/**` → LEAD-ONLY territory (gates, lane-guard, ops scripts incl. the untracked
  wipe script); no teammate edits it. The lead also syncs `scripts/lane-guard.sh` whenever
  this map changes.
- `.claude/agent-memory/**` → SHARED between the code-reviewer and the security-reviewer. This
  is a carve-out from the lead-owned `.claude/**` row below; without it a reviewer writing its
  own memory would look like a lane violation.
  Stated precisely, because the guard and this map must not drift again: `scripts/lane-guard.sh`
  enforces the SUBTREE, not per-reviewer separation — both reviewers can write anywhere under
  `.claude/agent-memory/**`, and a cross-reviewer write is permitted. That is deliberate and
  should not be "fixed" by narrowing the guard: `MEMORY.md` is a shared index both reviewers
  update, and the current layout is asymmetric anyway (`code-reviewer/` is a directory while
  the security reviewer's memory is the single file `security-review.md`), so a path-specific
  rule would either break the shared index or encode an accident of layout. Per-reviewer
  separation here is CONVENTION, not enforcement. The guard's purpose is to keep a
  read-only reviewer out of application code, which it does; it is a lane guard, not an ACL.
- `constitution.md`, `AGENTS.md`, `.claude/**` (EXCEPT `.claude/agent-memory/**` above),
  `.codex/**`, `package.json`/lockfile,
  `tsconfig.json`, `eslint.config.js`, `.prettierrc*`, `.gitignore`, `.prettierignore` → lead
  (dependency adds are requested via the lead). Both agent-toolchain directories are
  lead-owned and tracked: `.claude/**` and `.codex/**` describe how this repo is worked on and
  are reviewed with the code. `.duet/**` is deliberately NOT here — it is untracked
  peer-review working state (`.gitignore`), owned by whoever is running the section.
  NOTE: `RUNBOOK.md` is ARCHITECT-owned via the `docs`/root-docs row above, not lead-owned.
- The subscriber store (`data/**`, `*.sqlite*`), `.env*`, and any key files are SENSITIVE:
  no role edits them with the model; secrets come from the environment.
