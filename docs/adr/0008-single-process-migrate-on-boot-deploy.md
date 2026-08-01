# 8. Single-VPS deploy: serve SPA/API together and migrate once

Date: 2026-06-05
Status: Accepted — production migration mechanism superseded by 2026-07-23 amendment

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

## Amendment (2026-07-23)

The single application image and combined SPA/API process remain accepted. The production
topology is now one VPS with Caddy as the only public service, separate API and worker
processes, PostgreSQL, and Redis on private Compose networks.

The migrate-on-app-boot portion is superseded. Production schema changes run through the
one-shot Compose `migrate` service before app/worker replacement. The server does not
migrate on boot and rejects `AUTO_MIGRATE_DEV=1` in production; that switch exists only
for process-owned local PGlite.

Operational consequences:

- Caddy obtains TLS and app/worker remain private.
- App and worker wait on healthy PostgreSQL/Redis and a successful one-shot migration.
- `/api/health` is liveness; `/api/ready` checks PostgreSQL, Redis, and outbox age. Both
  are private operator probes through the Compose network.
- The optional backup profile encrypts PostgreSQL dumps to off-host restic storage; the
  isolated restore-check profile verifies the newest dump without touching production.

These are implemented deployment mechanisms, not evidence that any production deploy,
off-host snapshot, or restore drill has succeeded. See `docs/runbook-production.md`.
