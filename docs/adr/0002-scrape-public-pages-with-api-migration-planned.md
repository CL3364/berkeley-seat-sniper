# 2. Use public class pages behind a replaceable source seam

Date: 2026-06-05
Status: Accepted — amended 2026-07-23 and 2026-07-27 (through spec v0.4.6)

## Context

Availability data has two possible sources:

- **The public class pages** at `classes.berkeley.edu/content/<section>` — keyless,
  publicly visible, but unstructured HTML. The constitution already concedes the parser
  "WILL break when the upstream HTML changes," and scraping carries IP-block risk and a
  terms-of-service grey area.
- **The official Berkeley SIS Class API** — sanctioned and structured, but its published
  access policy does not permit student access. The owner cannot obtain a faculty/staff
  sponsor, so credentials are unavailable for this project.

v1 is already built on the scraper, and the system is cleanly layered: the worker,
notifier, and UI depend only on `fetchClass(section) → ParseResult`. The data source sits
entirely behind that seam, so it can be swapped without touching the monitor core.

## Decision

Launch v1 on the existing public-page source behind the `fetchClass → ParseResult` seam.
The SIS API is neither a launch dependency nor an available fallback. Reconsider an API
adapter only if Berkeley later makes legitimate credentials available to this project.
The 2026-07-27 amendment supersedes the original permission/ToS launch gate below. Two
conditions now bind the public-page launch:

1. **Owner risk acceptance is explicit.** The pages are public and unauthenticated, but
   recurring automated-access permission is unconfirmed. The project does not claim
   Berkeley authorization, endorsement, affiliation, or legal clearance.
2. **Source safety is non-negotiable:** current robots policy must not disallow the exact
   content path; one centralized poller deduplicates Sections, uses cache-aware
   conditional requests, a monitored contactable User-Agent, a bounded global ceiling,
   jitter/backoff, and the kill-switch. Robots disallow, a class-page 403/429, a direct
   stop request, or operational harm stops source fetching immediately.

## Consequences

- **+** Ships now with no external dependency, registration, or secret to manage.
- **+** The `ParseResult` seam preserves the ability to add an approved source later
  without coupling the worker/notifier/UI to HTML.
- **−** Carries ongoing HTML brittleness (mitigated by saved-fixture tests + the
  parser-broke Operator alert) and IP-block / ToS exposure.
- **Launch gate:** current robots disallow blocks public-source launch. A 403/429 or
  operational-harm signal stops an active source until explicit Operator review and
  reset. Written permission is not required under the owner-accepted risk posture.

## Historical gate observation (2026-06-09)

- **robots.txt: historically observed not to disallow the path.** A single read of
  `classes.berkeley.edu/robots.txt` on 2026-06-09 returned a stock Drupal robots file in
  which `/content/` was not disallowed for `User-agent: *` and no `Crawl-delay` was set.
  This dated observation is neither current policy nor permission for automated access.
- **Terms/permission: UNCONFIRMED.** This was originally a launch blocker; the 2026-07-27
  owner-risk amendment below supersedes that requirement without asserting permission.
- **Code posture decided (2026-06-09):** the scraper moves from fail-open to the RFC 9309
  posture — robots 404 → allowed; 5xx/unreachable → treat as disallowed and skip fetching
  that cycle — and robots.txt is cached per poll cycle instead of refetched per class.

## Alternatives considered

- _Re-architect onto the official API now_ — rejected under current conditions because
  student access is explicitly unavailable and the owner has no eligible sponsor.
- _Commit to scraping permanently_ — rejected; it treats a known-brittle, block-prone,
  grey-area source as load-bearing forever.

## Amendment (2026-07-23)

The owner confirmed no faculty/staff sponsor can be obtained. Public pages are therefore
the **only available technical source in v1**, historically conditional on the former
ToS/poll-rate gate and now governed by the 2026-07-27 risk amendment. Their HTTP cache can
hide SIS changes for many minutes, so the product
promises notification only after a changed page representation becomes observable.

The source must:

- honor `Age`, `Cache-Control`, ETag/Last-Modified, robots rules, 429, and `Retry-After`;
- use no cache-busting parameters;
- begin at one origin request/second and admit unique Sections only within the calculated
  source-visible target capacity;
- identify itself, remain kill-switchable, and validate returned page identity;
- expose last successful observation/staleness rather than imply live SIS data.

If Berkeley later grants legitimate API access, a new ADR must approve and specify that
adapter; this document does not presume or schedule such access.

## Amendment (2026-07-27)

The owner cannot obtain written or affirmative permission and explicitly chooses to
proceed without it. Public visibility is accepted as the data-source basis, but is not
described as authorization. This is a product risk acceptance, not legal advice or a
guarantee that the origin will not block the service.

The former permission/ToS confirmation blocker is removed. Launch instead requires:

- a current robots evaluation that does not disallow the exact class-page path;
- one centralized, deduplicated poller with cache-aware conditional requests;
- a monitored, contactable identifying User-Agent and a bounded global ceiling;
- jitter/backoff plus an exercised kill switch; and
- immediate source stop on robots disallow, class-page 403/429, direct stop request, or
  observed operational harm, with explicit Operator review before reset.

The v0.4.3 amendment changed permission policy only. Its numeric-rate note is superseded
by the v0.4.5 decision below.

## Amendment (2026-07-27, v0.4.5)

The owner selects option A:

- `SOURCE_REQUESTS_PER_SECOND=1` is a strict ceiling of one physical request/second to
  the Berkeley origin globally across the entire application—not per Subscriber,
  worker/process, or Section.
- Robots, class-page, conditional, and redirect attempts share the same limiter.
  Cache-aware scheduling can issue fewer requests; one/second is not a traffic target.
- `SOURCE_VISIBLE_TARGET_SECONDS=120` remains. The capacity formula
  `floor(0.8 × 1 × 120)` admits at most 96 distinct activated live Sections watched by
  Confirmed Subscribers. Its reserve covers robots/redirect requests, jitter/backoff,
  cache variance, and operating headroom.
- The pilot measures physical request mix, cache behavior, and source-visible p95. If
  the two-minute target is not sustained, admission/capacity is reduced rather than
  exceeding the global ceiling.

This closes the numeric-rate blocker only. It does not establish permission or launch
readiness and does not turn source traffic on. `KILL_SWITCH=1` remains the tracked state
until the current robots evaluation, contactable User-Agent, live-source canary,
deployment configuration, and all other rollout gates pass.

## Amendment (2026-07-27, v0.4.6)

The option A ceiling is measured at actual physical request starts. The origin limiter
owns the callback that synchronously invokes every robots, class-page, conditional, and
redirect fetch. It durably writes a conservative pre-start reservation, then reconciles
the actual invocation time before normal exclusive-fence handoff. A failed reservation
starts no request; a failed post-start reconciliation retains the fence and admits no
later request.

A graceful abort, kill-switch, or safety interruption after a successful durable
reservation but before invocation may release the fence normally. It does not roll the
future reservation back, so a later owner cannot start early; normal release alone does
not require Operator reset, although an independently engaged safety-stop marker does.

Operator reset cannot compress this spacing after a crash: for valid state it atomically
writes `lastPermitAt=max(existing lastPermitAt, reset time)` and preserves any later
cooldown before clearing the fence. It never moves a future boundary backward. This
amendment changes neither the one-global-request/second ceiling, the 120-second target,
nor the 96-Section maximum.
