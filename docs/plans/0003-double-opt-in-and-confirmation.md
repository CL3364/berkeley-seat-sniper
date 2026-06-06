# Plan 0003 — Double opt-in (email confirmation before alerting)

Status: Planned (not started) — diverges from shipped v1
Decision: [ADR 0001](../adr/0001-double-opt-in-before-alerting.md)

## Goal

Stop returning the Manage token in the subscribe response. Create a **Pending Subscriber**
and email the Manage/confirm link; send Alerts only to **Confirmed Subscribers**.

## Contract / shared (architect versions `src/shared` first)

- `POST /api/subscriptions` response changes from `201 { subscriberId, token, watches }`
  to `202 { status: 'pending' }` (no token, no id over the wire). Update `API_ROUTES` +
  spec §4 + AC-1/AC-2b (they assert the token in the body today — they must change).
- New `POST /api/subscriptions/confirm/:token` (or `GET` for click-through) → marks the
  Subscriber confirmed and returns the manage view / redirects to the dashboard.

## Schema (db lane)

- `subscribers.confirmed_at timestamptz null` (null = Pending). Add a partial index for the
  Pending-purge sweep (Plan 0004).
- `createSubscriberWithWatches` returns the new id but the route no longer exposes it; it
  mints a confirm token and hands it to the notifier instead of the HTTP response.

## Notifier lane

- New template: confirmation email ("confirm to start watching") carrying the confirm link.
- Worker fan-out gate: `getSubscribersWatching` must return only **Confirmed** Subscribers
  (add a `confirmed` filter), so Pending Subscribers receive no Alerts.

## Backend lane

- Subscribe handler: create Pending + dispatch confirmation; return 202.
- Confirm handler: verify token → set `confirmed_at` → success page; idempotent.

## UI lane

- After subscribe: "Check your inbox to confirm and start watching" (no deep-link).
- A confirm landing route that calls the confirm endpoint and then shows the manage view.

## Tests

- Pending Subscriber receives no Alert even when a watched Section opens.
- Confirm flips state; a confirmed Subscriber then receives Alerts.
- Subscribe response carries no token/id (the old AC-1/AC-2b assertions are rewritten).

## Risks

- Hard dependency on a **real** mail transport at signup (noop is dev-only). Deployment
  must configure it before launch.
- Confirmation deliverability: clear copy + the resend path (Plan 0005).
