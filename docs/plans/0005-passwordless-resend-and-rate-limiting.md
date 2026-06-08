# Plan 0005 — Passwordless link resend + rate limiting

Status: Planned (not started)
Decision: [ADR 0005](../adr/0005-passwordless-recovery-non-enumerating-and-rate-limited.md)

## Goal

Give Subscribers a way to recover a lost Manage link without enumeration, and throttle the
email-sending endpoints so they can't be weaponized (implements the contract's reserved
`rate_limited` 429).

## Contract / shared

- New `POST /api/subscriptions/resend` `{ email }` → **always** `202 { status: 'sent' }`
  regardless of whether the address exists (non-enumerating). Add to `API_ROUTES` + spec.
- `rate_limited` (429) becomes a real response on `subscribe` and `resend`.

## Backend lane

- Resend handler: look up the Subscriber by email; if found, mint a fresh Manage link and
  dispatch it via the notifier; **either way** return the same 202 after the same work
  (constant-ish time — avoid a timing oracle: do the lookup either way).
- Rate-limit middleware: per-IP and per-email sliding window (e.g. 3 / 15 min / address,
  N / min / IP) → 429 `rate_limited`. Apply to `subscribe` and `resend`.

## Rate-limit store

- Single instance: in-memory token bucket / fixed window (simplest; fine to launch).
- Multi-instance: shared store (Redis — the constitution already lists it). Abstract behind
  a `RateLimiter` interface so the store is swappable; default in-memory.

## Notifier

- Reuse the Manage-link template for resend; no new PII in logs (subscriberId + counts only).

## UI

- "Lost your link? Enter your email and we'll resend it" form → always shows the same
  reassurance ("If that address is subscribed, we've emailed its link").

## Tests

- Resend for an existing address sends mail; for a non-existent address sends none — both
  return identical 202 bodies (no enumeration).
- Exceeding the window returns 429 `rate_limited` on subscribe and resend.
- No email/address in logs (AC-8 holds).

## Risks

- A mistyped address yields a success-shaped response and no mail (cost of non-enumeration)
  — mitigate with clear copy.
- In-memory limits reset on deploy/restart; acceptable single-instance, move to Redis for HA.
