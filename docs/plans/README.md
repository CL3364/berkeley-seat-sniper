# Implementation plans (deferred / future work)

Each plan is a pick-up-later spec for a decision recorded in an ADR but **not yet built**.
Convention: when the grill (or any review) accepts a forward decision, capture the
rationale in `docs/adr/` and the executable plan here.

Read the linked ADR first, then the plan. Plans name the contract/schema/lane changes,
tests, and sequence so a future implementer (or the agent team) can start cold.

| Plan | What | Decision | Status |
|------|------|----------|--------|
| [0001](0001-sis-class-api-migration.md) | Move availability source to the official SIS Class API (behind the `fetchClass → ParseResult` seam) | [ADR 0002](../adr/0002-scrape-public-pages-with-api-migration-planned.md) | Planned |
| [0002](0002-course-level-any-section-watches.md) | Course-level "any section" Watches (Alert once when any section opens) | [ADR 0004](../adr/0004-watch-is-atomic-at-the-section.md) | Planned |
| [0003](0003-double-opt-in-and-confirmation.md) | Double opt-in: confirm email before alerting; token no longer in the subscribe response | [ADR 0001](../adr/0001-double-opt-in-before-alerting.md) | Planned |
| [0004](0004-term-scoped-expiry.md) | Term-scoped expiry of Watches + purge of Subscribers / Pending | [ADR 0003](../adr/0003-term-scoped-data-expiry.md) | Planned |
| [0005](0005-passwordless-resend-and-rate-limiting.md) | Non-enumerating "resend my link" + rate limits (implements 429) | [ADR 0005](../adr/0005-passwordless-recovery-non-enumerating-and-rate-limited.md) | Planned |

## Suggested build order

1. **0003 double opt-in** + **0005 resend/rate-limit** together — they share the
   email-sending + token-delivery surface and are launch-blockers for safe email.
2. **0001 SIS API** — removes the scraping brittleness/ToS risk and gives reliable section
   enumeration that 0002 depends on.
3. **0004 term expiry** — small, can land any time after the schema is stable.
4. **0002 course-level Watches** — the headline next feature; do it on top of 0001.

Each plan is self-contained; the architect versions `src/shared` first for any that change
the contract (0001 maybe, 0002, 0003, 0005), then the lanes follow.
