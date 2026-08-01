# Plan 0007 — Launch tuning backlog (small forward tweaks)

Status: Planned (not started)
A catch-all for small, easily-reversible changes agreed in review that don't each warrant
an ADR or a full plan. Keep items here until built, then delete.

## Items

1. **Cap repeat Alerts per (Subscriber, Section).** (Grill Q9.) The worker currently
   re-Alerts on every genuine Seat Opening, uncapped. Add a cap of N Alerts per
   (subscriber, section) per rolling window (e.g. 3 / hour), then a cooldown, so a
   flapping Section can't fatigue a Subscriber into unsubscribing. Each Opening is still a
   real shot; the cap only bounds noise. Small worker-lane change + a tiny per-pair
   counter (in-memory single instance; shared store for HA). Tunable via env.

2. **Fixed ~30s per-Section cadence — superseded 2026-07-27.** The v0.4.5 source
   decision uses cache-aware deadline scheduling, not a fixed per-Section promise.
   `SOURCE_REQUESTS_PER_SECOND=1` is one physical Berkeley-origin request/second globally
   across robots, class, conditional, and redirect attempts; the 120-second
   source-visible target yields a maximum of 96 Confirmed-demand Sections. No cadence
   tweak may create a per-user/per-Section request allowance or bypass cache deadlines.

3. **Label the Opening kind in Alert copy.** (Grill Q4.) The notifier email must clearly
   say "Seat opened" vs "Waitlist spot opened" so a Waitlist Opening is never mistaken for
   an enrollable seat. Notifier-lane copy change.

4. **One-click List-Unsubscribe header (RFC 8058).** Add `List-Unsubscribe` +
   `List-Unsubscribe-Post` headers to every Alert so inbox providers show a native
   unsubscribe and Subscribers leave in one click — which itself protects sender
   reputation. Pairs with the resend/unsubscribe surface (Plan 0005). Notifier-lane change.

## Notes

The remaining items are deliberately not ADRs (each is reversible config/copy). The
superseded cadence item is governed by spec v0.4.5 and ADR 0002. Promote another item to
its own plan/ADR only if it grows into a real trade-off.
