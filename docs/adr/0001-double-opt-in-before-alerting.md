# 1. Double opt-in before alerting

Date: 2026-06-05
Status: Accepted and implemented; required before any pilot/public launch

## Context

The shipped v1 `POST /api/subscriptions` mints a Manage link token and returns it
directly in the 201 response body, with no check that the requester controls the
email address. Consequences:

- **Spam-others vector.** Anyone can subscribe any address they type (e.g.
  `victim@berkeley.edu`) to many Sections, and that inbox immediately starts receiving
  Alerts it never asked for.
- **Deliverability risk (existential).** Unsolicited Alerts get marked as spam. For an
  email-based alerter, the sending domain's reputation _is_ the product — once it is
  flagged, even _wanted_ Alerts stop reaching inboxes. There is no recovering the value
  proposition (speed of notification) if the mail doesn't land.

The competing value was frictionless signup: returning the token in the body let the
dashboard deep-link a Subscriber straight into the Manage view with no email round-trip.

## Decision

Adopt **double opt-in**. A new subscribe request creates a **Pending Subscriber** and
sends the Manage link to the email out-of-band. The token is **no longer returned in the
response body**. Only **Confirmed Subscribers** (those who have followed the link at
least once) receive Alerts.

## Consequences

- **+** Closes the spam-others vector; an address only receives Alerts after its owner
  acts.
- **+** Protects sender-domain reputation and therefore deliverability.
- **+** The Manage link becomes a true bearer secret delivered only to the inbox that
  owns the subscription, removing the unauthenticated-token-in-body exposure.
- **−** Adds one click of friction and a hard dependency on the mail path working at
  signup time (the noop transport is dev-only; a real transport is now required to launch).
- **−** Requires a `confirmed` state on the Subscriber, a confirmation endpoint, and a
  contract change: `POST /api/subscriptions` no longer returns `token` (it returns an
  accepted/`202`-style acknowledgement). The architect must version `src/shared` and the
  spec accordingly.
- **Risk:** if the confirmation email is slow or lands in spam, signups stall. Mitigate
  with a reliable transport, clear copy ("check your inbox to start watching"), and a
  resend path.

## Alternatives considered

- _Create now, gate only Alerts on confirm_ — keep returning the token but send no
  Alerts until confirmed. Lower friction, but still hands an unauthenticated caller a
  working Manage token for an address they may not own.
- _Ship as-is for a trusted launch_ — accept the risk for a small known audience.
  Rejected: the deliverability blast radius is not contained to the abuser; one spam
  flag degrades the channel for every Subscriber.
