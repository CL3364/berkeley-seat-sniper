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

2. **Reconcile the poll cadence default to ~30s.** (Grill Q2.) `env.example` says
   `POLL_INTERVAL_SECONDS=120`, the worker default is 60 — they disagree. Set the canonical
   default to 30 (the fan-out makes per-Section load trivial at student-group scale) and
   make `env.example` + the worker agree.

3. **Label the Opening kind in Alert copy.** (Grill Q4.) The notifier email must clearly
   say "Seat opened" vs "Waitlist spot opened" so a Waitlist Opening is never mistaken for
   an enrollable seat. Notifier-lane copy change.

4. **One-click List-Unsubscribe header (RFC 8058).** Add `List-Unsubscribe` +
   `List-Unsubscribe-Post` headers to every Alert so inbox providers show a native
   unsubscribe and Subscribers leave in one click — which itself protects sender
   reputation. Pairs with the resend/unsubscribe surface (Plan 0005). Notifier-lane change.

## Notes

These are deliberately not ADRs (each is reversible config/copy). Promote an item to its
own plan/ADR only if it grows into a real trade-off.
