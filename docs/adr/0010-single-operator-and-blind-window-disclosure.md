# 10. A deployment has one Operator, and blindness is disclosed to Subscribers

Date: 2026-08-25
Status: Accepted — resolves the OPEN BLOCKER carried in spec §"Rollout gates" and in the
2026-07-30 amendment to ADR 0009

## Context

`OPERATOR_EMAIL` is a hard boot gate: the application refuses to start with any non-noop
mail transport unless it is set (env.example:142). The blocker text that has sat in the
spec since v0.4.5 demanded "a named primary and a named backup on a mailbox with push
notifications." That demand was never satisfiable, and the reason is structural rather
than a matter of finding a second volunteer.

**Receiving an Operator alert and acting on one are the same job.** There is deliberately
no HTTP control route into a running deployment — "the Docker/OS access boundary is the
authorization check" (docs/runbook-production.md:530). Clearing a dead-letter incident
means `psql` on the host. Stopping a source-safety violation means editing `.env` and
recreating containers in order. A person who can only read the mailbox resolves nothing,
so a "backup" who is not also a credential holder is decorative. Making them a real
backup means handing a second person SSH and direct access to a database holding real
students' email addresses — a materially wider trust boundary than a four-person
friends-only pilot justifies.

Two further facts, both verified against the code rather than assumed:

1. **The system fails soft.** The poll loop contains no readiness or incident gate; the
   worker keeps scraping and dispatching regardless of what `/api/ready` reports. The
   app container's healthcheck targets `/api/health`, not `/api/ready`
   (docker-compose.yml:294), so a red readiness restarts nothing. Readiness is an
   advisory signal, and it is not reachable from outside the compose network.

2. **The two incident classes have inverted blast radius.** A dead-letter incident holds
   readiness at 503 until a human clears it (src/server/app.ts:513) but costs exactly one
   undelivered message while everything else keeps working — loud, low impact. A parser
   break stops Alerts for the affected Section entirely and notifies the Operator exactly
   once, never repeating until a later successful parse rearms it — quiet, high impact.
   The existing alerting is loudest for the least urgent failure.

The deployment is run by one student who attends classes and sleeps. Alerts expire within
the hour by design, so a break discovered the next morning means affected Subscribers got
nothing and never knew it.

## Decision

**The Operator is singular by definition.** A deployment has exactly one Operator: the
sole holder of host credentials, who both receives Operator alerts and is the only party
able to resolve them. There is no backup Operator and no rota. The spec's demand for a
named primary and backup is withdrawn, not deferred.

**No incident wakes the Operator.** Response is best-effort within waking hours. Inbox
cadence tracks the enrollment calendar rather than the clock: roughly daily in ordinary
weeks, and several times a day during Phase 1/2 appointments and the adjustment period,
when a parser break actually costs someone a seat. Sleep is not an incident-response tier.

**Because the first two decisions guarantee blind windows, blindness is disclosed to the
Subscriber.** When the system cannot read a watched Section continuously for 60 minutes,
it sends that Section's watchers exactly one email per Blind window, never repeated,
telling them the system is not currently watching and that silence should not be trusted
until it clears. The 60-minute boundary is not a new constant: the product already treats
seat information older than an hour as no longer actionable, and reuses that horizon here.

This is the FR-27 honesty rule applied to availability. The product already refuses to let
an unobserved reserved-seat count render as zero; it must equally refuse to let "we could
not look" render as "no Opening happened." A Blind window is the single condition under
which the system contacts a Subscriber in the absence of an Opening, and the alert-fatigue
budget spends here rather than on the loud-but-harmless dead-letter path.

**`OPERATOR_EMAIL` is a plus-alias on the Operator's existing personal account**, filtered
server-side to a dedicated label with mobile push enabled on that label only. A filtered
label inside an inbox the Operator already lives in is monitored in practice; a separate
dedicated mailbox is monitored only in theory, which is precisely the failure mode the
original blocker warned about. Swapping the address later is a one-line env change.

**Pilot expectation-setting lives in the personal invitation**, not in product copy. Each
friend is told directly that this is best-effort, that an overnight break may stay broken
until morning, and to keep their own backup plan. At four invitees the conversation is the
honest channel, and the Blind-window email carries the same caveat inline at the moment it
actually matters.

## Consequences

- The rollout blocker is **resolved**, not waived. Nothing about the pilot's other gates
  changes: real transport, double opt-in, authenticated SPF/DKIM/DMARC, robots/ToS
  confirmation, and the source-safety stop all still stand.
- **New scope**: Blind-window detection and its once-per-window Subscriber email do not
  exist yet. This ADR creates that work; the pilot must not launch on the claim of
  disclosure without the disclosure being built. It needs a functional requirement in the
  spec, worker-side window tracking with the same once-per-episode discipline as the
  existing parser-broke Operator alert, and its own alert-copy tests.
- A red `/api/ready` remains advisory and is **not** an outage. It marks work the Operator
  owes the system, discoverable at the next scheduled check.
- The product's worst-case honestly stated: a Section can go unwatched for hours. Every
  affected Subscriber learns this within the hour, so the failure is disclosed even when
  it cannot be promptly repaired. Disclosure is the commitment; uptime is not.
- Any future deployment run by more than one person invalidates this ADR rather than
  extending it. Multi-operator working requires a real handoff protocol so two credential
  holders never act on one incident at once — out of scope here and deliberately unbuilt.

## Alternatives considered

**Name a backup with real host access.** Genuine redundancy, and the only option that
shortens time-to-resolution rather than time-to-detection. Rejected: it widens access to
subscriber PII for a four-person pilot, and creates a concurrent-action hazard with no
handoff protocol to contain it. Revisit only if the audience ever grows past friends.

**A Spotter — a second person who watches the inbox and escalates by phone, holding no
credentials.** Cuts detection time without widening the trust boundary. Rejected as
premature: it buys nothing that the Blind-window email does not already buy the people who
actually care, and it obliges a friend to carry a pager for someone else's side project.

**Wake the Operator on parser-break only, via a phone channel.** Matches urgency to impact
and directly fixes the inverted blast radius. Rejected for now on cost and honesty: the
Operator channel is email-only today, so it needs a second transport plus re-alerting
(parser-broke deliberately fires once), and a commitment to answer a 3am page from one
student is one that would quietly stop being kept. Disclosing the gap beats promising to
close it and failing.

**Disclose nothing; rely on the dashboard's existing stale indicator.** Zero new code, and
the indicator already exists (src/components/ManageView.tsx:243). Rejected: it is pull, not
push, and the entire premise of the product is that a Subscriber does not have to keep
checking. An indicator only the diligent see does not discharge the obligation.
