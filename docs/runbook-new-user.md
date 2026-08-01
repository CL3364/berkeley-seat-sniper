# New-user runbook — clean checkout to a working, verified product

This guide takes a brand-new contributor from `git clone` to a local Berkeley Seat
Sniper and exercises the safe, offline verification paths in `specs/spec.md` §7
(AC-1–AC-30). Everything uses **saved fixtures and the no-op mail transport**: it sends
no real email and makes no live `classes.berkeley.edu` request. Live source/inbox and
restore drills are separate, owner-controlled release gates.

Each step states its expected result so you can tell pass from fail.

---

## 0. Prerequisites

- Node.js 22 and npm
- Docker Engine + Compose plugin for the production-topology smoke and real
  PostgreSQL/Redis test lanes
- gitleaks and Semgrep for the strict security gate

```sh
git clone <your-repo-url> seat-sniper && cd seat-sniper
npm ci
```

**Pass condition:** install exits zero. Treat any high/critical production advisory as
release-blocking; do not use a forced dependency rewrite as a shortcut.

## 1. Environment

```sh
cp env.example .env
```

Edit `.env` and set exactly these for a local verification run:

```
TOKEN_SECRET=any-random-string-at-least-32-characters-long
APP_BASE_URL=http://localhost:8787
ADMISSION_MODE=public
MAIL_TRANSPORT=noop
NOOP_OUTBOX_FILE=test-results/outbox.ndjson
AUTO_MIGRATE_DEV=1
KILL_SWITCH=1
SOURCE_SAFETY_STOP_FILE=/tmp/seat-sniper-source-safety-stop.json
SOURCE_ORIGIN_STATE_FILE=/tmp/seat-sniper-origin-state.json
FETCH_USER_AGENT=SeatSniperLocal/1 (+mailto:<your-berkeley-email>)
```

Notes:

- `TOKEN_SECRET` must be ≥32 chars or the server/worker refuse to start under a
  real transport (spec §6 fail-loud; the noop path warns instead).
- Admission defaults to `closed`. This guide sets `public` only so an isolated local
  verification can create test Subscribers without a shared bearer. The production
  template and every undeclared deployment stay `closed`; do not copy this local choice
  into production.
- `NOOP_OUTBOX_FILE` is the dev/test-only outbox sink — this is where you will
  "receive" your emails. It contains addresses + tokens by design; it lives under
  the gitignored `test-results/`. Never set it in production.
- `OPERATOR_EMAIL` / `RESEND_API_KEY` / VAPID keys are NOT needed for noop runs.
- `AUTO_MIGRATE_DEV=1` initializes local, process-owned PGlite. Production rejects this
  switch and uses the one-shot `migrate` service instead.
- Source fetching is explicit opt-in: only exact `KILL_SWITCH=0` enables it. `1`,
  missing, empty, boolean-looking, malformed, and every other value stay disabled.
  Option A is selected: `SOURCE_REQUESTS_PER_SECOND=1` is one physical Berkeley-origin
  request/second globally across all users, Sections, workers, robots/class requests, and
  redirects—not one per user or Section. Cache-aware scheduling may use less.
  `SOURCE_VISIBLE_TARGET_SECONDS=120` computes a maximum of 96 unique Sections held by
  Confirmed demand. The tracked kill switch stays `1` until separate live-source and
  rollout gates pass.
- `SOURCE_SAFETY_STOP_FILE` is the durable local marker used when robots disallows the
  content path or a class-page request returns 403/429. A marker survives worker restart
  on the same filesystem and fails source fetching closed; never edit or delete it by
  hand. A 429 marker contains a bounded, non-PII `resumeNotBefore` no earlier than the
  effective bounded worker recovery delay / bounded origin `Retry-After`; restart and
  reset cannot bypass it. An early CLI reset reports fixed classification
  `resume_deadline_active`. Backward-readable origin-state v2 in
  `SOURCE_ORIGIN_STATE_FILE` preserves `lastPermitAt` plus a bounded
  `notBefore`/`notBeforeSetAt` cooldown and automatically uses a sibling `.fence` file.
  Physical starts honor the later of configured spacing and `notBefore`; a 429 persists
  this cutoff before engaging the marker. The limiter durably reserves a start, owns the
  synchronous fetch invocation, and reconciles the actual start before normal fence
  handoff; reconciliation failure retains the fence. The reset CLI clears the safety
  marker/stale fence only after atomically advancing valid `lastPermitAt` to at least
  reset time without moving a future boundary backward, while preserving any later
  cooldown. If origin state is missing/malformed/unreadable, reset reinitializes
  `lastPermitAt` to reset time only when the atomic repair succeeds; otherwise reset
  exits nonzero and source stays stopped. If neither 429 deadline persists, eligibility
  is unknown: keep source stopped for explicit review and a conservative wait.
  Production's named volume survives container recreation but not `down -v`, volume
  deletion/pruning, or host loss, so deployment config must independently retain exact
  `KILL_SWITCH=1` throughout recovery.
- Subscriber examples must still use an exact `@berkeley.edu` address. In noop mode it
  need not be a deliverable mailbox because nothing leaves the process.

## 2. Verify the build the way CI does (5–10 minutes)

```sh
npm run format:check
npm run lint -- --max-warnings=0
npm run typecheck
npm test
npm run e2e
SECURITY_GATE_STRICT=1 ./scripts/security-gate.sh
./scripts/acceptance-check.sh
```

**Pass condition:** every command exits zero. Do not infer a fixed test count; the suite
grows with the contract.

`acceptance-check.sh` is a 20-check offline wire smoke, not the whole AC-1–AC-30 release
gate. It boots a real server on `:8791` with an isolated temporary PGlite database, durable
mail outbox, worker drain, no-op transport, and temporary outbox/server-log files. It
checks liveness/readiness, Berkeley/lookalike and body bounds, subscribe/no-token,
duplicate, durable confirmation, idempotent confirm/manage, known-vs-unknown resend,
source capacity, Pending push/VAPID posture, one-click unsubscribe, and PII/token-free
logs. Its trap deletes the entire temporary directory on exit: there is no persistent
`acceptance-server.log`. It currently makes no rate-limit assertion.

Some real-service tests are opt-in locally. To include them, point
`TEST_DATABASE_URL` at a disposable PostgreSQL database and `TEST_REDIS_URL` at a
disposable Redis instance before `npm test`:

```sh
TEST_DATABASE_URL='postgres://<user>:<password>@127.0.0.1:5432/<test-db>' \
TEST_REDIS_URL='redis://127.0.0.1:6379/0' \
npm test
```

`TEST_DATABASE_URL` enables fresh/upgrade migration tests in an isolated schema;
`TEST_REDIS_URL` enables the shared-window/restart limiter test. Never point either at
production. CI supplies both real services. Without them those named tests skip, so a
plain local `npm test` alone is not full production evidence.

The fixture-driven monitoring ACs run inside `npm test`; to see them by name:

```sh
npx vitest run tests/integration/worker-cycle.test.ts tests/integration/worker-v03.test.ts --reporter=verbose
```

**Pass condition (each listed as ✓):** AC-3 (0→>0 flip alerts each Confirmed subscriber
exactly once), AC-4 (second open poll sends nothing — dedupe), AC-5 (shape-changed
fixture → operator alert, zero subscriber mail, `class_state` untouched), AC-6
(KILL_SWITCH=1 → zero fetches), AC-9 (Pending subscriber gets no alert), AC-14
(404/not-found fixture → watch retired, no operator page), AC-15 (operator alert
once per broken episode; recovery resets; robots outage collapses to one alert).

Those `worker-cycle` / `worker-v03` files are compatibility regression subsets. Their
names and a green legacy v0.3 subset do not prove the v0.4.1 production contract,
real-service durability, admission modes, Compose isolation, backups, or live canaries;
run the complete command set and release gates.

## 3. Start the app

Terminal 1 — API server + built SPA:

```sh
npm run build     # Expected: tsc clean + vite build completes
npm start         # AUTO_MIGRATE_DEV initializes local PGlite, then starts :8787
```

Terminal 2 (optional) — exercise the worker kill switch without source traffic:

```sh
FETCH_USER_AGENT='SeatSniperLocal/1 (+mailto:<your-berkeley-email>)' KILL_SWITCH=1 npm run worker
```

**Pass condition:** the worker records kill-switch cycles and performs **no outbound
fetch**. Stop it with Ctrl-C. Local API and worker PGlite instances are intentionally
separate; use Compose for a shared database/topology test.

> **[LIVE — owner risk acceptance and source controls required]** Running the worker
> with exact `KILL_SWITCH=0` polls real `classes.berkeley.edu` pages for watched Sections;
> every other value remains disabled.
> Recurring automated-access permission is unconfirmed; the owner accepts that risk, and
> the project makes no claim of Berkeley authorization or endorsement. A 2026-06-09
> robots observation is historical, not current authorization. Do not flip the switch
> until the production runbook verifies deployed `SOURCE_REQUESTS_PER_SECOND=1` and
> `SOURCE_VISIBLE_TARGET_SECONDS=120`, records a current non-disallowing robots
> evaluation, a monitored contactable User-Agent, and a tested safety stop / kill switch.
> Stop immediately on robots disallow, 403, 429, a direct stop request, or operational
> harm. There is no student-accessible SIS API fallback.

The supported safety-stop reset is intentionally explicit:

```sh
npx tsx src/worker/source-safety-stop-cli.ts RESET_SOURCE_SAFETY_STOP
```

Do not run it as a shortcut to resume traffic. For a real recovery, first persist
`ADMISSION_MODE=closed` and recreate the app, verify existing manage/recovery access,
then persist exact `KILL_SWITCH=1` and recreate the worker. Diagnose the trigger, evaluate
current robots policy and exact configured `SOURCE_REQUESTS_PER_SECOND=1` /
`SOURCE_VISIBLE_TARGET_SECONDS=120`, and inspect a 429 marker's `resumeNotBefore` plus
origin-state `notBefore`. The reset command refuses before a persisted marker timestamp
even after restart with fixed classification `resume_deadline_active`; permits
independently honor a valid origin cooldown. Once eligible, run reset inside the
worker/runtime volume and verify the safety marker/fence are absent, origin
`lastPermitAt` is at least both its valid pre-reset value and reset time, any later
`notBefore` is preserved (or invalid state was atomically repaired to reset time), and
the worker still reports disabled. A repair/monotonic-update failure exits nonzero and
leaves source stopped. If both deadlines failed to persist, wait conservatively after
explicit review before resetting the retained fence. Only a later, separately reviewed
change to exact `KILL_SWITCH=0` may resume fetching, and pilot/public admission stays
closed until source recovery review.
The exact production commands and checks are in the
[parser/source incident procedure](runbook-production.md#parsersource-failure).

## 4. Subscribe (AC-1, AC-2)

1. Open `http://localhost:8787`.
2. Enter an exact Berkeley test identity (e.g. `local-check-seat@berkeley.edu`) and a
   class URL such as
   `https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001`
   — or the short code `2026-fall-compsci-189-001-lec-001`.
3. Submit.

**Expected:** the page shows **"Check your inbox to confirm"**. No manage link
appears anywhere. (Wire truth: the response was `202 {"status":"pending"}` with
no token.)

Negative check (AC-2): submit `me@example.com`, `me@sub.berkeley.edu`, a lookalike
domain, or a garbage class id first. **Expected:** an inline error appears and no
subscription/outbox row is created. Confirmation proves mailbox control only; it does not
prove enrollment.

Duplicate check (AC-2b): submit the same email again — **Expected:** an inline
"already subscribed" error; the response is a 409 with only an `{error}` body.

Optional AC-25 pilot journey: restart the local server with
`ADMISSION_MODE=pilot` and a private 32–256-character unpadded-base64url
`PILOT_INVITE_CODE`, then open
`http://localhost:8787/?invite=<urlencoded-code>` in a fresh tab. **Expected:** the app
immediately removes `?invite=` from the address/history, retains the bearer only for that
tab's session, and sends it in `x-seat-sniper-invite-code` when you submit. A fresh tab
without the link and a tab with a wrong code both receive the same
`503 admission_unavailable` and `Retry-After: 3600`; neither response explains why. Use a
local disposable bearer and never put a production bearer in terminal output or evidence.

## 5. "Receive" the confirmation email and confirm (AC-1 tail, AC-10)

```sh
grep '"confirmation"' test-results/outbox.ndjson | tail -1
```

**Expected:** one NDJSON line addressed to your email whose body contains a line
like `http://localhost:8787/?confirm=<token>`.

1. Open that URL in the browser.
2. **Expected:** a "Confirm your email" view with a **Confirm my email** button
   (nothing happens on mere page load — scanner-safe).
3. Click it. **Expected:** you land in **Manage your subscription**, showing your
   email, `Confirmed` state, and the watched class.
4. AC-10: open the same `?confirm=` URL again and click again. **Expected:** you
   land in manage again with no error; no extra email appears in the outbox.

Pending-banner check: if you repeat steps 4–5 with a second address and open its
`?token=` manage URL **before** confirming, **Expected:** a banner "Confirm your
email to start receiving alerts." — gone after you confirm.

## 6. Trigger a 0→>0 Opening and receive the Alert (AC-3), then dedupe (AC-4)

The poller's transition logic runs against SAVED FIXTURES in the test suite (step
2 above proves AC-3/AC-4 end-to-end through the real poller + notifier + outbox).
To watch it happen interactively rather than in a test run:

```sh
npx vitest run tests/integration/worker-cycle.test.ts --reporter=verbose
```

**Expected:** the AC-3 block shows poll 1 (zero-seats fixture) = baseline, empty
outbox; poll 2 (open-seats fixture) = **exactly one `alert` outbox entry per
Confirmed subscriber**, and the AC-4 block shows a third still-open poll adds
**nothing**. The alert body includes the reserved-seat caveat (ADR 0006) and the
`List-Unsubscribe` headers.

## 7. Parser-broke operator alert (AC-5, AC-15) and class-gone (AC-14)

Same mechanism — the `changed-shape.html` and `class-not-found.html` fixtures:

```sh
npx vitest run tests/integration/worker-v03.test.ts --reporter=verbose
```

**Expected:** AC-15: a class broken for 3 consecutive cycles produces exactly ONE
operator entry (debounce), recovery is logged, the next break alerts once more,
and a robots-level outage across many classes collapses to a single operator
alert. AC-14: the not-found fixture retires the watch (it disappears from manage,
is not fetched next cycle), pages nobody, and re-adding it from manage revives it.

## 8. Manage watches (AC-1/FR-2) and resend (AC-11)

In the manage view: add a second class (**Expected:** it appears in the list;
adding a duplicate shows a conflict error), then remove it (**Expected:** gone).

Lost-link recovery: on the subscribe page, use **"Email me my link"** with your
subscribed address, then with a made-up address. **Expected:** both show the
identical reassurance ("If that address is subscribed, we've emailed its link");
`grep '"manage-link"' test-results/outbox.ndjson` shows an entry for the real
address only.

## 9. Web push (AC-16)

With VAPID unset (this runbook's config), the manage view's **Browser push
alerts** section shows a "not configured" note — that is the correct state.
AC-16a/b (payload contains no token/URL; push failure never blocks email; a 410
cleans up the endpoint) are proven in step 2's suite. To enable push for real,
generate VAPID keys (`npx web-push generate-vapid-keys`), set the three `VAPID_*`
env vars, restart, and the toggle appears for Confirmed subscribers.

## 10. Suppression webhook (AC-13)

Bounce/complaint suppression is signature-gated (`RESEND_WEBHOOK_SECRET`) and
proven in step 2's suite, including: valid-signature bounce → 204 + address
suppressed (no further alert/confirmation/manage mail to it, others unaffected),
bad signature → 401 and nothing suppressed, stale timestamp (replay) → 401 even
with a valid HMAC. The raw webhook body is rejected at 32,769 bytes before
signature verification or JSON parsing; 32,768 bytes may proceed.

## 11. Unsubscribe (AC-7)

In the manage view click **Unsubscribe** → confirm the dialog. **Expected:**
"Unsubscribed" state; revisiting the old manage URL shows "Unable to load
subscription", and the old confirm URL errors. A later Opening of the class sends
that address nothing (step 2's AC-7 test proves the fan-out side).

## 12. No-PII logging (AC-8)

`acceptance-check.sh` checks its private temporary server log for both Berkeley addresses
and signed tokens, then deletes it. During the interactive run, inspect the server/worker
terminal output: only opaque ids and counts may appear—never subscriber addresses,
tokens, pilot invite query/header values, or watch lists. The outbox NDJSON file is the
sanctioned dev/test exception and exists only because you set `NOOP_OUTBOX_FILE`.

---

## 13. v0.4.2 infrastructure, durability, and admission checks (AC-17–AC-30)

The unit/integration suites cover widened real-world class keys and parser fixtures,
source capacity/freshness, transactional outbox crash points, 72-hour/90-day retention,
64 KiB request limits, Redis limits across instances, real PostgreSQL migrations, and the
closed/pilot/public admission matrix. AC-25 additionally requires real-PostgreSQL
concurrency evidence that at most 100 current pilot Subscribers commit. AC-26–AC-30 cover
production env rejection, dead-letter operations, scheduler isolation, disabled-source
readiness, and backup-marker readiness.

The base Compose model is intentionally production-only: it pins
`MAIL_TRANSPORT=real`/`MAIL_PROVIDER=resend` and requires all mail and authenticated-proxy
values. For a safe local container smoke, use the explicit test override, which changes
only the app/worker roles to `NODE_ENV=test` + noop mail. Because Compose resolves the
base model before merging the override, fill these smoke-only non-secret placeholders in
your local `.env` as well:

```text
POSTGRES_PASSWORD=local-compose-password
PROXY_HEADER_SECRET=local-compose-proxy-secret-00000000000001
MAIL_FROM=noreply@ci.invalid
OPERATOR_EMAIL=ops@ci.invalid
RESEND_API_KEY=local-compose-not-used
```

Generate a valid smoke-only webhook placeholder directly into the gitignored, untracked
`.env` file:

```sh
node <<'NODE'
const { randomBytes } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const path = '.env';
const key = 'RESEND_WEBHOOK_SECRET';
const value = ['wh', 'sec_', randomBytes(32).toString('base64')].join('');
const current = readFileSync(path, 'utf8');
if (!new RegExp(`^${key}=.*$`, 'm').test(current)) {
  throw new Error(`${key} is missing from ${path}`);
}
writeFileSync(path, current.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`));
NODE
```

Do not commit `.env`. These placeholders are never used to send because the override
selects noop. Keep
`APP_BASE_URL=http://localhost`, `CADDY_BIND_ADDRESS=127.0.0.1`,
`ADMISSION_MODE=closed`, and `KILL_SWITCH=1`, then run:

```sh
docker compose -f docker-compose.yml -f docker-compose.test.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d --wait
docker compose -f docker-compose.yml -f docker-compose.test.yml ps
```

**Pass condition:** only Caddy publishes a host port; app, worker, PostgreSQL, and Redis
are live/private; the one-shot `migrate` service completed successfully. Private
`/api/health` returns 200. Private `/api/ready` deliberately returns 503 with
`worker.disabled: true` while `KILL_SWITCH=1`; this proves the source brake does not take
recovery/manage ingress down. Both paths return 404 through Caddy. This test override
omits production backup-marker gating and does not prove an off-host backup, restore,
live Berkeley source, DNS, or inbox delivery.

Stop the disposable local topology when finished:

```sh
docker compose -f docker-compose.yml -f docker-compose.test.yml down --volumes --remove-orphans
```

That command deletes this disposable local Compose project's volumes, including any
source-safety state. Never run it against a production project or during source-incident
recovery.

## Going live

Do not infer launch readiness from this guide. Follow the
[production operations runbook](runbook-production.md) for the owner risk-acceptance
record, current robots and bounded-rate safety gates, one-shot migration, DNS/Resend
provisioning, backups and restore checks, deploy/rollback, incident response, key
rotation, and the two-week pilot gates. (`public` admission is not a v1 goal — owner
decision 2026-07-30; `pilot` is the terminal mode for v1.)
