# 9. Launch posture: closed pilot with real email, double opt-in before public

Date: 2026-06-06
Status: Accepted

## Context

The "ready to launch" review forced an explicit launch-sequencing decision. Two facts
constrain it:

- The `noop` mail transport sends no real Alerts (it writes to an inspectable outbox for
  testing). So a **real email transport** (provider + authenticated domain — Plan 0008) is
  a **hard gate for any launch that delivers value**: with noop, a subscriber gets nothing.
- Double opt-in (ADR 0001) is an anti-abuse / deliverability layer _on top_ of email. It
  depends on the same email infra and adds signup friction.

The app is otherwise verified launch-ready: it runs as a single process (ADR 0008), the
full subscribe → manage → unsubscribe journey works in a real browser, and all gates pass.
What remained was _how_ to roll out given the email dependency.

## Decision

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

## Pilot → public exit criteria

Before opening beyond the trusted pilot: double opt-in live (0003); resend + rate-limit
(0005); List-Unsubscribe on every message (0007/0008); deliverability healthy (SPF/DKIM/
DMARC aligned, low complaint rate); robots/ToS for scraping confirmed (ADR 0002) or the
SIS API migrated (Plan 0001).

## Alternatives considered

- _No launch until double opt-in + email both ship_ — safest, but delays all feedback and a
  trusted pilot does not need it.
- _Public launch now without double opt-in_ — exposes exactly the spam-others / sender-
  reputation risk ADR 0001 exists to prevent. Rejected.
