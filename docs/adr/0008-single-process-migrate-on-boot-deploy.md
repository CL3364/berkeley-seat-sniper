# 8. Single-process deploy: migrate on boot, serve the SPA and the API together

Date: 2026-06-05
Status: Accepted

## Context

Launch-readiness testing (actually running the app, not just the in-process tests)
surfaced two gaps the unit/integration suite could not catch because it uses an
auto-migrating in-memory database and never boots the real server:

1. The server constructed the DB but never ran migrations on startup, so a fresh process
   had no tables and every request failed.
2. The server served only `/api`; the built single-page app was never served, so there was
   no single runnable product.

We had to choose a deploy shape.

## Decision

Ship as **one Node process** that, on startup, runs pending migrations (fail-loud: it
exits non-zero rather than serve an empty database) and then serves **both** the built SPA
(`dist/web`, with an `index.html` fallback for client-side routing) **and** the `/api`
routes. Unmatched `/api/*` paths return a JSON 404 envelope (never the SPA). A **separate
worker process** runs the poller. Caddy fronts the app for TLS and proxying.

## Consequences

- **+** One image, two commands (server, worker); the simplest thing that is a real product.
- **+** Dev/prod parity; deep links (`/?token=...`) work because non-API GETs fall back to
  the SPA shell.
- **+** Migrate-on-boot means a deploy can't start serving against a schema that isn't there.
- **−** Migrate-on-boot races if several app instances start concurrently. Drizzle's
  migration bookkeeping makes a double-apply safe, but at horizontal scale the correct shape
  is a **separate one-shot migration job / init container** that runs before app instances
  start. Documented as the scale path; single-instance launch is fine as-is.
- **−** The app process serves static files. Fine at student-group scale; a CDN or Caddy
  can serve `dist/web` directly later if static traffic grows.

## Why this was documented (not grilled)

This is an operational default with a clear, conventional trade-off — not a contested
product decision — so it is recorded as an ADR rather than run through a full grill session.
The one thing a future reader will question ("why migrate on every boot?") is answered above,
along with the scale caveat.
