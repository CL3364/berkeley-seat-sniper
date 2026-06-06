# 7. Alerts send via a transactional provider on an authenticated subdomain

Date: 2026-06-05
Status: Accepted (implementation pending — see docs/plans/0008)

## Context

The product is email-first: an Alert's value is entirely in landing in the inbox, fast.
ADR 0001 protects deliverability in principle (only Confirmed Subscribers get mail); this
ADR is the operational other half. The shipped `smtp.ts` is a stub. Without authenticated
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
- **−** Requires provider signup + cost, DNS control for the subdomain, and replacing the
  `smtp.ts` stub with a real provider adapter (keys from env). Launch now depends on DNS.
- **−** Need bounce/complaint handling to auto-suppress bad addresses (else reputation
  erodes) — folded into Plan 0008.

## Alternatives considered

- _Raw SMTP via a generic/department mailbox_ — cheapest, but poor deliverability at
  volume, shared-domain reputation, and hard rate caps. Rejected for a time-critical
  alerter.
- _Defer hygiene_ — rejected; early spam-foldering poisons reputation from day one, which
  is precisely what ADR 0001 set out to prevent.
