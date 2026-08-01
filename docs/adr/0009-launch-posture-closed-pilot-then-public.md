# 9. Launch posture: closed by default, invite-only pilot, then public

Date: 2026-06-06
Status: Accepted, then **PARTIALLY SUPERSEDED 2026-07-30** — amended through 2026-07-27 spec
v0.4.5; the "then public" arm is withdrawn (see amendment below); operational gates remain open

> **Amendment 2026-07-30 (owner decision, spec v0.5.0).** The third arm of this ADR — "then
> public" — is **withdrawn**. The service is local first, then **friends-only by invitation**,
> and is deliberately never opened to every Berkeley student. `pilot` is the terminal admission
> mode for v1.
>
> What this changes: the pilot → public exit criteria below (§"Original pilot → public exit
> criteria" and step 4 of the amended sequence) are **no longer pending work**. They are retained
> as the bar that would apply if the decision were ever revisited. Nothing in v1 is scoped toward
> reaching them, and an unmet public gate is not an outstanding v1 item.
>
> What this does NOT change, and the distinction matters: every gate protecting the _pilot_ still
> stands in full — real mail transport, double opt-in (ADR 0001), authenticated SPF/DKIM/DMARC,
> robots/ToS confirmation for public-page polling, the source-safety stop, and a **monitored
> Operator inbox**. Friends-only lowers the audience, not the bar; the pilot still runs the
> production-grade flow. The Operator inbox in particular remains an explicitly UNASSIGNED
> blocker (spec §"Rollout gates") and no invitation goes out until it has a named primary and
> backup.
>
> The filename retains "then-public" for link stability; read the title as historical.

## Context

The "ready to launch" review forced an explicit launch-sequencing decision. Two facts
constrain it:

- The `noop` mail transport sends no real Alerts (it writes to an inspectable outbox for
  testing). So a **real email transport** (provider + authenticated domain — Plan 0008) is
  a **hard gate for any launch that delivers value**: with noop, a subscriber gets nothing.
- Double opt-in (ADR 0001) is an anti-abuse / deliverability layer _on top_ of email. It
  depends on the same email infra and adds signup friction.

At the original review, the in-repository subscribe → manage → unsubscribe journey had
been verified. That did not prove production DNS, inbox delivery, source permission,
backups, or live canaries. What remained was _how_ to roll out given the email dependency.

## Original decision (superseded by the amendments below)

Launch in this order:

1. **Real email transport is a hard prerequisite** for any launch (Plan 0008). The `noop`
   config is dev/test only and is never "launched."
2. **First launch is a CLOSED PILOT** to a small, trusted audience (e.g. one student group)
   using the current token-in-body flow (double opt-in deferred), with deliverability and
   abuse monitoring on from day one.
3. **Double opt-in (Plan 0003) + the resend/rate-limit surface (Plan 0005) + one-click
   List-Unsubscribe are the gate before opening to the PUBLIC.**

## Consequences

- **+** Delivers real value and real user feedback quickly, with abuse risk bounded by a
  trusted audience + monitoring.
- **+** Honors ADR 0001 where it matters most (a public, untrusted audience).
- **−** The pilot lacks double opt-in, so a trusted subscriber could still enter someone
  else's address. Bounded by the small known audience and monitored; not acceptable at
  public scale (hence the gate).
- **−** Even the pilot needs real email infra first — there is no "soft launch" on noop.

## Original pilot → public exit criteria

Before opening beyond the trusted pilot: double opt-in live (0003); resend + rate-limit
(0005); List-Unsubscribe on every message (0007/0008); deliverability healthy (SPF/DKIM/
DMARC aligned, low complaint rate); and robots/ToS for public-page polling confirmed
(ADR 0002). The SIS API is not available under the current student-access policy.

## Alternatives considered

- _No launch until double opt-in + email both ship_ — safest, but delays all feedback and a
  trusted pilot does not need it.
- _Public launch now without double opt-in_ — exposes exactly the spam-others / sender-
  reputation risk ADR 0001 exists to prevent. Rejected.

## Amendment (2026-06-09)

The owner raised the bar for "launchable": the target is **public-ready**, and the
token-in-body pilot (step 2 above) is **withdrawn**. The original sequencing is replaced by:

1. Real email transport remains a hard prerequisite for any launch (unchanged).
2. The full public bundle is built and verified BEFORE any launch, pilot included:
   double opt-in (Plan 0003), resend + per-email rate limits (Plan 0005),
   List-Unsubscribe + deliverability hygiene (Plan 0008), and the operator-alerting
   pilot minimum (Plan 0009).
3. The first launch is still a **closed pilot** to a trusted student group — but it now
   runs the public-grade flow and doubles as the low-volume warmup for the fresh sending
   subdomain (Plan 0008's volume ramp).
4. Public follows once deliverability is healthy (SPF/DKIM/DMARC aligned, low complaint
   rate) and robots/ToS for scraping is confirmed (ADR 0002) or the SIS API is migrated
   (Plan 0001).

Rationale: the original pilot exception traded ADR 0001's protections for speed of
feedback. The owner chose instead to spend the build time now so no audience — trusted or
not — ever receives the unauthenticated token-in-body flow, and the pilot exercises
exactly what the public gets.

## Amendment (2026-07-23, v0.4)

The pilot and public rollout use the v0.4 production contract:

1. Subscriber admission requires an exact, double-opted-in `@berkeley.edu` mailbox.
   Mailbox control does not claim current enrollment.
2. Public `classes.berkeley.edu` pages are the only v1 availability source. Student API
   access is unavailable and the owner has no sponsor, so SIS migration is not an
   alternative launch gate.
3. Written owner approval of the applicable terms and request ceiling was a hard blocker.
   This item is superseded by the 2026-07-27 owner-risk amendment below.
4. Before any pilot, provision domain/TLS, Resend quota, SPF/DKIM/DMARC, the signed
   bounce/complaint webhook, monitored `OPERATOR_EMAIL`, encrypted off-host backups, and a
   successful timed restore drill.
5. The closed pilot runs at least two weeks, with at most 100 accounts and
   `min(500, computed source capacity)` unique Sections (96 under the initial ceiling).
6. At the time of this amendment, public admission opened only after the then-current
   AC-1–AC-25 range plus source/inbox canaries, source-visible latency, outbox health,
   deliverability, rollback, and kill-switch evidence were healthy. The current release
   gate is AC-1–AC-30.

This amendment records the decision and required evidence; it does not claim those
external provisioning steps or live canaries have passed.

## Amendment (2026-07-23, v0.4.1)

Deployment state and subscriber admission are now mechanically separate:

1. `ADMISSION_MODE=closed|pilot|public` is required semantically and defaults to `closed`.
   The production/default template is `closed`; an invalid mode fails startup.
2. `closed` blocks only creation of new Subscribers. Existing resend, confirmation,
   token-scoped manage/watch/push, and unsubscribe flows stay available so an incident or
   paused rollout never locks out existing people.
3. `pilot` requires the shared `PILOT_INVITE_CODE` bearer in the
   `x-seat-sniper-invite-code` create header and atomically caps all current Pending +
   Confirmed Subscriber rows at 100. Unsubscribe and the 72-hour Pending purge release
   slots. The repository receives only the numeric cap, never the bearer.
4. The Operator privately shares `${APP_BASE_URL}/?invite=<urlencoded-code>`. The client
   immediately strips that query with `history.replaceState`, keeps the code only in
   sessionStorage, sends it only in the create header, and clears it after a 202. The code
   is shared bearer access—not identity, mailbox verification, or a per-user invitation.
   Anyone who obtains it and controls an exact Berkeley mailbox can request admission.
5. `public` requires no invite; exact-`@berkeley.edu` requests still pass double opt-in,
   Redis abuse limits, and unique-Section capacity admission.
6. Closed, missing/wrong/malformed/oversize invite, and full-pilot denials are
   byte-identical: `503 admission_unavailable` with a fixed `Retry-After: 3600`. They
   reveal no deployment mode, code validity, or account count. The 32–256-character
   unpadded-base64url bearer is timing-safe compared and must never be stored, echoed,
   logged, included in telemetry, or copied into durable mail.

This is a fail-safe rollout control, not a substitute for the source, email, restore, or
pilot evidence above. The Operator changes to `pilot` only after all pilot hard gates and
to `public` only after all public gates; a leaked bearer is rotated and the pilot remains
capped.

## Amendment (2026-07-27, v0.4.3)

The owner explicitly accepts launching on the public, unauthenticated class pages while
recurring automated-access permission remains unconfirmed. Written or affirmative
Berkeley permission and a positive ToS determination are no longer rollout prerequisites.
This project does not claim Berkeley authorization, endorsement, affiliation, legal
clearance, or a guarantee against blocking.

Before the worker may poll live pages, release evidence must instead show a current
robots evaluation that does not disallow the exact content path, one centralized
deduplicated and cache-aware poller, a monitored contactable User-Agent, an internally
selected bounded global ceiling, and an exercised safety stop / kill switch. Robots
disallow, a class-page 403/429, a direct stop request, or observed operational harm stops
source fetching immediately until explicit Operator review and reset.

This amendment changed permission policy only. Its rate/SLO/capacity note is superseded
by the v0.4.5 decision below.

## Amendment (2026-07-27, v0.4.5)

The owner selects option A: `SOURCE_REQUESTS_PER_SECOND=1` is one physical
Berkeley-origin request/second globally across every Subscriber, worker/process, and
Section, not an allowance for each. Robots, class-page, conditional, and redirect
attempts share it. With `SOURCE_VISIBLE_TARGET_SECONDS=120`, the capacity formula admits
at most 96 distinct activated live Sections watched by Confirmed Subscribers.

The two-week pilot must measure robots/redirect overhead, cache behavior, actual request
mix, and source-visible p95. If the two-minute target is not sustained, reduce
admission/capacity rather than exceed the one-request/second ceiling.

This closes only the numeric source-rate blocker. `KILL_SWITCH=1`,
`ADMISSION_MODE=closed`, current robots evidence, a contactable User-Agent, live-source
and inbox canaries, deployment configuration, mail/DNS/backup readiness, and the other
rollout gates remain independently binding. This amendment does not claim Berkeley
permission, authorization, endorsement, or launch readiness.
