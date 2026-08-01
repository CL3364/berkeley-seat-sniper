# 7. Alerts send via a transactional provider on an authenticated subdomain

Date: 2026-06-05
Status: Accepted — repository implementation complete; production DNS/provider gates open

## Context

The product is email-first: an Alert's value is entirely in landing in the inbox, fast.
ADR 0001 protects deliverability in principle (only Confirmed Subscribers get mail); this
ADR is the operational other half. Without authenticated
sending, a provider with inbox reputation, and a trivial unsubscribe, time-critical Alerts
get spam-foldered — and a few spam complaints poison the channel for everyone.

## Decision

Send Alerts (and confirmation/resend mail) via a **reputable transactional email provider**
(e.g. Resend / Postmark / Amazon SES) from a **dedicated, authenticated sending subdomain**
(e.g. `alerts.<domain>`) with **SPF + DKIM + DMARC** configured, and a **one-click
List-Unsubscribe** header (RFC 8058) on every message.

## Consequences

- **+** Best inbox placement; the provider manages IP reputation and feedback loops.
- **+** A dedicated subdomain isolates the alerter's sending reputation from the apex
  domain — a spam complaint about Alerts doesn't taint the org's primary mail.
- **+** One-click unsubscribe both satisfies bulk-sender requirements and protects
  reputation (people unsubscribe instead of hitting "spam").
- **−** Requires provider signup + cost, DNS control for the subdomain, and a live
  provider adapter (keys from env). Launch now depends on DNS.
- **−** Need bounce/complaint handling to auto-suppress bad addresses (else reputation
  erodes) — folded into Plan 0008.

## Alternatives considered

- _Raw SMTP via a generic/department mailbox_ — cheapest, but poor deliverability at
  volume, shared-domain reputation, and hard rate caps. Rejected for a time-critical
  alerter.
- _Defer hygiene_ — rejected; early spam-foldering poisons reputation from day one, which
  is precisely what ADR 0001 set out to prevent.

## Implementation status (2026-07-23)

The repository includes the Resend adapter, bounded request-start throttling, one provider
request per durable job, a durable outbox, RFC 8058 headers, and signed bounce/complaint
suppression. Provider batching is deliberately disabled: a transient DB claim batch is not
a stable retry/idempotency unit. Every retry reuses the job's provider key and renders the
same link from a durable timestamp (`opened_at` for an Alert, outbox `created_at` for
Confirmation/Manage-link work). The remaining launch work is external: create/size the
account, authenticate DNS, register the webhook, set a monitored Operator inbox, and pass
controlled inbox/deliverability canaries. No live provider or DNS result is asserted by
this ADR.
