# Plan 0008 — Email deliverability setup (provider, domain auth, hygiene)

Status: Repository implementation complete; external production provisioning remains open
Decision: [ADR 0007](../adr/0007-transactional-provider-authed-subdomain.md)

## Goal

Make Alerts land in the inbox: a real transactional provider, an authenticated sending
subdomain, and unsubscribe/bounce hygiene. Replaces the `smtp.ts` stub.

## Provider

- Pick one transactional provider (Resend, Postmark, or Amazon SES). Decision criteria:
  deliverability reputation, a clean sending interface, webhooks for bounces and
  complaints, and cost at expected volume. (Postmark = great transactional deliverability;
  SES = cheapest at scale; Resend = simplest developer experience.) Record the choice here
  when made.
- **DECIDED 2026-06-09: Resend.** The adapter already exists as the code's only live path;
  simplest API at student-group volume, with bounce/complaint webhooks available. Account
  provisioning + SPF/DKIM/DMARC on the sending subdomain remain the owner's task; all
  in-repo verification runs against the noop transport and a fake client.
- Key from env only (`MAIL_PROVIDER`, `<PROVIDER>_API_KEY`); never hardcode/log.

## DNS / domain auth (the deliverability core)

- Dedicated sending subdomain `alerts.<domain>` (isolates reputation from the apex).
- **SPF**: authorize the provider's sending hosts.
- **DKIM**: add the provider's signing keys (CNAME/TXT).
- **DMARC**: start `p=none` with `rua` reporting to monitor, then tighten to
  `p=quarantine` once aligned.
- Verify alignment (SPF+DKIM pass and align with the From subdomain) before any real send.

## Adapter (notifier lane — `src/notify/**`)

- Maintain the shipped Resend provider adapter implementing the existing
  `Transport` interface (`send(message)`); the Notifier layer + outbox + idempotency are
  unchanged. The noop transport stays the default for dev/test.
- Add `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers
  (RFC 8058) to every message; the unsubscribe URL is the token-scoped unsubscribe
  (ties to Plan 0005). (Also tracked in Plan 0007 item 4.)

## Bounce / complaint hygiene

- Subscribe to the provider's bounce + complaint webhooks; on a hard bounce or a spam
  complaint, suppress the address (stop sending) and consider purging it (ties to ADR 0003
  retention). This protects sender reputation and keeps the PII surface clean.

## Warmup / volume

- Ramp send volume gradually on a fresh subdomain; the student-group launch is naturally
  low-volume, which helps.

## Tests

- Adapter unit test against a fake provider client (no real network); asserts the message
  shape + that the API key comes from env.
- Header presence test: every outgoing message carries List-Unsubscribe(-Post).
- No secret/address in logs (AC-8 holds).

## Launch checklist

- [ ] Provider account + API key in prod env
- [ ] `alerts.<domain>` SPF/DKIM/DMARC verified (alignment passes)
- [ ] Provider adapter live; noop still default in dev/test
- [ ] List-Unsubscribe one-click verified in Gmail + Outlook
- [ ] Bounce/complaint webhook suppressing addresses
