# Implementation plans and decision backlog

Each plan records implementation intent for a decision. Its status is authoritative:
some are implemented, some remain future work, and Plan 0001 is blocked by external access.
Convention: when the grill (or any review) accepts a forward decision, capture the
rationale in `docs/adr/` and the executable plan here.

Read the linked ADR first, then the plan. Plans name the contract/schema/lane changes,
tests, and sequence so a future implementer (or the agent team) can start cold.

| Plan                                                       | What                                                                                                         | Decision                                                                          | Status                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------- |
| [0001](0001-sis-class-api-migration.md)                    | Move availability source to the official SIS Class API (behind the `fetchClass → ParseResult` seam)          | [ADR 0002](../adr/0002-scrape-public-pages-with-api-migration-planned.md)         | Blocked: no student access/sponsor |
| [0002](0002-course-level-any-section-watches.md)           | Course-level "any section" Watches (Alert once when any section opens)                                       | [ADR 0004](../adr/0004-watch-is-atomic-at-the-section.md)                         | Planned                            |
| [0003](0003-double-opt-in-and-confirmation.md)             | Double opt-in: confirm email before alerting; token no longer in the subscribe response                      | [ADR 0001](../adr/0001-double-opt-in-before-alerting.md)                          | Implemented                        |
| [0004](0004-term-scoped-expiry.md)                         | Term-scoped expiry of Watches + purge of Subscribers / Pending                                               | [ADR 0003](../adr/0003-term-scoped-data-expiry.md)                                | Planned                            |
| [0005](0005-passwordless-resend-and-rate-limiting.md)      | Non-enumerating "resend my link" + rate limits (implements 429)                                              | [ADR 0005](../adr/0005-passwordless-recovery-non-enumerating-and-rate-limited.md) | Implemented                        |
| [0006](0006-reservation-aware-alerting-and-eligibility.md) | Reservation-aware alerting: parse reserved-seat groups + per-Subscriber eligibility (depends on 0001)        | [ADR 0006](../adr/0006-reserved-seats-v1-is-blind-eligibility-deferred.md)        | Planned                            |
| [0007](0007-launch-tuning-backlog.md)                      | Small launch tweaks; fixed-cadence item superseded by the cache-aware global source-rate decision            | [ADR 0002](../adr/0002-scrape-public-pages-with-api-migration-planned.md)         | Remaining items planned            |
| [0008](0008-email-deliverability-setup.md)                 | Email deliverability: provider + authed subdomain (SPF/DKIM/DMARC) + bounce hygiene                          | [ADR 0007](../adr/0007-transactional-provider-authed-subdomain.md)                | Code done; provisioning open       |
| [0009](0009-operator-alerting-and-parser-broke-runbook.md) | Operator alerting for parser-broke: monitored destination + debounce + runbook + class-gone vs shape-changed | [ADR 0009](../adr/0009-launch-posture-closed-pilot-then-public.md)                | Code done; live drill open         |

## Current next-work order

1. Complete **0008 external provisioning** and the **0009 live incident/inbox drill**;
   follow [`../runbook-production.md`](../runbook-production.md).
2. Keep **0001 blocked** unless Berkeley legitimately changes access or an eligible
   sponsor becomes available and a new ADR reactivates it.
3. **0004 term expiry** + **0007 tuning backlog** can land after the schema is stable.
4. **0002 course-level Watches** and **0006 reservation-aware alerting** require fresh
   product/architecture decisions; they must not assume Plan 0001 will become available.

Each plan is self-contained; the architect versions `src/shared` first for any that change
the contract (0001 maybe, 0002, 0003, 0005), then the lanes follow.
