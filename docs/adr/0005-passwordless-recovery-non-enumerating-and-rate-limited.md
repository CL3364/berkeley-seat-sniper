# 5. Passwordless link recovery is non-enumerating and rate-limited

Date: 2026-06-05
Status: Accepted (implementation pending — see docs/plans/0005)

## Context

Double opt-in (ADR 0001) delivers the Manage link only to the Subscriber's inbox. Two
consequences follow:

- A Subscriber who loses the link is locked out — they cannot manage or unsubscribe, and
  re-subscribing returns 409 (duplicate email, by design).
- Every endpoint that sends mail (subscribe, and any resend) can be weaponized to bomb an
  inbox or to probe which addresses are subscribed (enumeration). The contract reserves
  `rate_limited` (429) but v1 does not implement it.

## Decision

Recovery is a single **"email me my Manage link"** endpoint with these properties:

- **Non-enumerating:** it always returns the same response ("if that address is
  subscribed, we've emailed its link") whether or not the address exists. It never reveals
  subscription status.
- **Rate-limited** per-address and per-IP; `subscribe` is rate-limited too, implementing
  the reserved 429.
- It is the **one** way to (re)deliver a Manage link; the token is never returned over
  HTTP (consistent with ADR 0001).

## Consequences

- **+** Closes lockout, enumeration, and email-bomb together.
- **+** Implements the contract's reserved `rate_limited` code.
- **−** Needs a rate-limit store: in-memory is fine for a single instance; multi-instance
  needs a shared store (Redis). This nudges the deployment toward the Redis the
  constitution already lists.
- **−** A user who mistypes their address gets a success-shaped response and no mail
  (the cost of non-enumeration). Clear copy mitigates confusion.

## Alternatives considered

- *Rate-limit only, no resend* — leaves the lockout unsolved.
- *Resend from the manage UI only* — circular (you need the link to reach the UI).
