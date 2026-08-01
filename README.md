# Berkeley Seat Sniper

Notify-only monitor that watches public Berkeley class pages and alerts a confirmed
`@berkeley.edu` mailbox when a maxed-out class opens a seat. No CalNet, credentials, or
auto-enroll. Mailbox confirmation proves control of that address—not current enrollment
or eligibility for a particular seat.

The public pages are the only v1 availability source because Berkeley's SIS Class API
does not allow student access and this project has no faculty/staff sponsor. Those pages
are cached, so the service reports source freshness and targets notification within two
minutes **after a changed page becomes observable**, not after the underlying SIS event.

New-Subscriber admission fails closed. `ADMISSION_MODE=closed` is the default,
`pilot` requires a shared invite bearer and atomically caps 100 current Subscribers, and
`public` accepts any exact Berkeley mailbox request subject to double opt-in and the
ordinary abuse/source-capacity limits. Closed mode preserves resend, confirmation, and
existing token-scoped management.

See [`specs/spec.md`](specs/spec.md) for the living spec and [`constitution.md`](constitution.md)
for project law. The API contract in [`src/shared`](src/shared) is the single source of truth.

## Stack

- **Frontend:** Vite + React + TypeScript (`src/client`, `src/components`)
- **Backend:** Hono + TypeScript (`src/server`, `src/api`)
- **Data plane:** PostgreSQL via Drizzle plus Redis for shared atomic abuse limits
- **Scraper / worker / notifier:** `src/scraper`, `src/worker`, `src/notify`
- **Production edge:** Caddy with automatic TLS; only Caddy publishes host ports
- **Tests:** Vitest (`tests`), Playwright (`e2e`)

## Develop

```bash
npm install
cp env.example .env   # fill in TOKEN_SECRET etc.; never commit .env
ADMISSION_MODE=public AUTO_MIGRATE_DEV=1 npm run dev:server   # local verification only
npm run dev:web       # Vite dashboard on :5173 (proxies /api -> :8787)
```

`AUTO_MIGRATE_DEV=1` is local-only and forbidden in production. When developing against
real PostgreSQL, set `DATABASE_URL`, run `npm run db:migrate` explicitly, and omit that
switch. The inline `ADMISSION_MODE=public` is likewise for an isolated test mailbox flow;
production/default remains `closed`.

## Production

The supported topology is one VPS running Caddy, API, one worker, PostgreSQL, Redis, and
encrypted off-host backups through Docker Compose. Schema migration is a one-shot release
step; the API does not migrate on boot. Production pins real Resend mail, authenticates
the Caddy→API forwarding hop, and cannot become ready without a fresh backup-success
marker. Deploy and validate with `ADMISSION_MODE=closed`; the production runbook controls
the later invite-only pilot transition. `public` is NOT a v1 goal (owner decision
2026-07-30): this service is local first, then friends-only by invitation, and `pilot` is
the terminal admission mode for v1.

After completing `.env` and all launch blockers:

```bash
docker compose config --quiet
docker compose build app
docker compose up -d db redis
docker compose run --rm migrate
docker compose --profile backup up -d backup
docker compose up -d --no-deps app worker
docker compose up -d --no-deps caddy
```

`/api/health` is process liveness and keeps recovery/manage ingress available during an
incident. `/api/ready` aggregates PostgreSQL, Redis, worker/source, unresolved
dead-letter, outbox, backup-marker, and runtime-volume DISK headroom (AC-23; production
requires `DISK_READINESS_PATH`, and missing/unreadable/below `HEALTH_DISK_MIN_FREE_KB`
fails closed); it is intentionally 503 while the source kill switch is active. Both probes are private and return 404 through Caddy.

Read the [production operations runbook](docs/runbook-production.md) before deploying.
It covers the owner-accepted public-source risk posture and mandatory source-safety
controls, DNS/Resend provisioning, backups and restore checks, rollback, incident
response, key rotation, the private
`/?invite=<code>` → session-only header pilot journey, and the (non-v1) public admission
procedure retained only as a record. For a clean
local verification journey, use the [new-user runbook](docs/runbook-new-user.md).

## Verify (the layered gates)

```bash
./scripts/fast-gate.sh          # format + lint on changed files (per task)
./scripts/integration-gate.sh   # typecheck + unit + integration + e2e (per feature)
SECURITY_GATE_STRICT=1 ./scripts/security-gate.sh   # secrets + deps + SAST
```

## Operating safety

- Notify-only; one centralized poller fetches each unique class once per eligible
  cache-aware cycle and fans out. The selected option A uses
  `SOURCE_REQUESTS_PER_SECOND=1` as one physical Berkeley-origin request/second globally
  across the whole app—not per user or Section. Robots, class-page, conditional, and
  redirect starts share that limiter. The limiter owns the synchronous fetch-start
  callback: it durably reserves before invocation, reconciles the actual start before
  normal fence handoff, and retains the fence on reconciliation failure.
  `SOURCE_VISIBLE_TARGET_SECONDS=120` yields a maximum of 96 distinct activated live
  Sections watched by Confirmed Subscribers; cache deadlines can make actual traffic
  lower. Jitter, backoff, a contactable `User-Agent`, and a global `KILL_SWITCH` add
  protection. Only exact `KILL_SWITCH=0` opts in; every other value disables source
  egress. The tracked setting remains `KILL_SWITCH=1` until the separate live-source and
  rollout gates pass.
- Fetched HTML is untrusted data — parsed with a real parser against saved fixtures; a
  parse break raises a distinct operator alert and never emits a false "0 seats".
- Subscriber emails + watch lists are sensitive: never logged, never committed.
- A pilot invite is shared bearer access, not identity. Keep it env/session-only; never
  store or log its URL/header, and rotate it if disclosed.
- The public pages are unauthenticated, but recurring automated-access permission is
  unconfirmed. The owner accepts that risk; this project does not claim Berkeley
  authorization or endorsement. Before live polling, verify the deployed one-global-
  request/second rate and 120-second target, record a current robots evaluation that does
  not disallow the exact path, use a monitored contactable `User-Agent`, and test the
  safety stop / `KILL_SWITCH`. Stop immediately on robots disallow, 403, 429, a direct
  stop request, or operational harm.
- `SOURCE_SAFETY_STOP_FILE` preserves an automatic source stop across worker-container
  recreation on the same `runtime_data` volume. Backward-readable origin-state v2 in
  `SOURCE_ORIGIN_STATE_FILE` preserves the last origin-permit timestamp and bounded
  `notBefore` cooldown, and uses a sibling `.fence` for durable global spacing. Permits
  use the later of spacing and `notBefore`. A 429 writes the effective bounded worker
  recovery delay / bounded origin `Retry-After` to origin state before storing the
  marker's non-PII `resumeNotBefore`; restart and explicit reset cannot bypass it, and an
  early reset reports `resume_deadline_active`.
  This state does not survive `down -v`, volume deletion/pruning, or host loss; never
  remove volumes during recovery, and independently persist `KILL_SWITCH=1`. Set
  `ADMISSION_MODE=closed`, recreate the app, and verify existing manage/recovery access
  before diagnosis. Never remove source-state files manually. Recovery runs
  `npx tsx src/worker/source-safety-stop-cli.ts RESET_SOURCE_SAFETY_STOP` inside the
  worker/runtime volume; it clears the safety marker/stale fence while preserving valid
  last-permit state. Missing/malformed/unreadable state is repaired to reset time only
  when an atomic state write succeeds; otherwise reset exits nonzero and source remains
  stopped. For valid state, reset advances `lastPermitAt` to at least reset time without
  moving a future boundary backward and preserves any later cooldown. A persistence
  failure retains the fence; if neither 429 deadline was persisted, eligibility is
  unknown and requires explicit review plus a conservative wait. Verify the effective
  deadline has passed, origin state is valid, and source remains disabled before a later
  reviewed change to exact `KILL_SWITCH=0`; reopen `pilot` only after source
  recovery review — recovering into `public` would silently widen admission past the
  friends-only posture. Follow the
  [incident procedure](docs/runbook-production.md#parsersource-failure).
