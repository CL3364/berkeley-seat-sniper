# Berkeley Seat Sniper

Notify-only monitor that watches public Berkeley class pages and alerts subscribers
the moment a maxed-out class opens a seat. No CalNet, no credentials, no auto-enroll —
a subscriber gives an email + a list of class URLs/codes, nothing more.

See [`specs/spec.md`](specs/spec.md) for the living spec and [`CONTEXT.md`](CONTEXT.md)
for the domain glossary. The API contract in [`src/shared`](src/shared) is the single source of truth.

## Stack

- **Frontend:** Vite + React + TypeScript (`src/client`, `src/components`)
- **Backend:** Hono + TypeScript (`src/server`, `src/api`)
- **Database:** Postgres via Drizzle ORM (`src/db`, `drizzle`) — tests run against an
  in-process Postgres (PGlite), production against a real Postgres via `DATABASE_URL`.
- **Scraper / worker / notifier:** `src/scraper`, `src/worker`, `src/notify`
- **Tests:** Vitest (`tests`), Playwright (`e2e`)

## Develop

```bash
npm install
cp env.example .env   # fill in TOKEN_SECRET etc.; never commit .env
npm run db:generate   # generate migrations from the schema
npm run dev:server    # Hono API on :8787
npm run dev:web       # Vite dashboard on :5173 (proxies /api -> :8787)
```

## Run in production (single process)

The server runs DB migrations on boot, then serves the built dashboard **and** the API on
one port; the worker is a second process. See [ADR 0008](docs/adr/0008-single-process-migrate-on-boot-deploy.md).

```bash
npm run build         # tsc + vite → dist/web
TOKEN_SECRET=... DATABASE_URL=postgres://... npm start   # serves SPA + /api on :8787
TOKEN_SECRET=... DATABASE_URL=postgres://... npm run worker   # the poller (separate process)
```

Or with containers (Postgres + app + worker):

```bash
# set POSTGRES_PASSWORD, TOKEN_SECRET, etc. in .env (gitignored)
docker compose up --build
```

`GET /api/health` returns `200 {"status":"ok"}` for liveness checks. With no `DATABASE_URL`,
the app falls back to an in-process Postgres (PGlite) — fine for local/dev, not for
production. Before a public launch, see the pre-launch gates in [docs/plans/](docs/plans/)
(email deliverability `0008`, double opt-in `0003`, rate-limit/resend `0005`).

## Verify (the layered gates)

```bash
./scripts/fast-gate.sh          # format + lint on changed files (per task)
./scripts/integration-gate.sh   # typecheck + unit + integration + e2e (per feature)
SECURITY_GATE_STRICT=1 ./scripts/security-gate.sh   # secrets + deps + SAST
```

## Operating safety

- Notify-only; one centralized poller fetches each unique class once per interval and
  fans out. Cadence, jitter, backoff, `User-Agent`, and a global `KILL_SWITCH` are env-tuned.
- Fetched HTML is untrusted data — parsed with a real parser against saved fixtures; a
  parse break raises a distinct operator alert and never emits a false "0 seats".
- Subscriber emails + watch lists are sensitive: never logged, never committed.
