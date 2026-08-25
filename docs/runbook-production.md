# Production operations runbook

This runbook operates Berkeley Seat Sniper on its supported single-VPS Docker Compose
topology: Caddy, API, one worker, PostgreSQL, Redis, and optional encrypted off-host
backups. The backup service is optional only for non-production inspection; a production
deployment cannot become ready without its fresh success marker. This runbook describes
required checks; it does **not** assert that a particular deployment,
restore drill, or live canary has passed.

## 1. Hard launch blockers

Do not send real mail or enable live polling until every item is recorded in the release
ticket:

- The owner records the 2026-07-27 decision to accept live use of the public,
  unauthenticated pages while recurring automated-access permission remains unconfirmed.
  This is risk acceptance, not a claim of Berkeley authorization, endorsement,
  affiliation, or legal clearance.
- A current robots evaluation does not disallow the exact
  `classes.berkeley.edu/content/*` path. The historical 2026-06-09 observation is not
  sufficient current evidence.
- The release records the selected option A values:
  `SOURCE_REQUESTS_PER_SECOND=1` as one physical Berkeley-origin request/second globally
  across the whole app, `SOURCE_VISIBLE_TARGET_SECONDS=120`, and no more than 96 distinct
  activated live Sections with Confirmed demand. Robots, class-page, conditional, and
  redirect attempts all consume the same limiter; this is never a per-user or
  per-Section allowance.
- The release records a monitored contact in the identifying `FETCH_USER_AGENT` and a
  successful safety-stop / `KILL_SWITCH` exercise. Robots disallow, a class-page 403/429,
  a direct stop request, or operational harm must stop source fetching immediately.
- The public-page source is accepted as the only v1 source. Berkeley's SIS Class API is
  unavailable to students, and this project has no faculty/staff sponsor. There is no API
  fallback.
- A production domain and its DNS are controlled by the operator.
- A Resend account has adequate daily/monthly quota, and a dedicated sending subdomain has
  aligned SPF, DKIM, and DMARC records.
- `OPERATOR_EMAIL` is a monitored inbox. Alerts must have an owned incident responder.
- An encrypted restic repository exists on storage outside the application VPS.
- Strict CI/security gates pass. A restore drill and owner-controlled source/inbox
  canaries still need to be executed for the release; repository tests do not prove them.

Subscriber admission is exact `@berkeley.edu` plus double opt-in. That proves mailbox
control only—not current enrollment, CalNet affiliation, or seat eligibility. Keep
`ADMISSION_MODE=closed` while any launch blocker is open.

## 2. Host and secrets

Prepare a maintained Linux VPS with the Docker Engine and Compose plugin. Permit inbound
SSH from the administration network and public TCP 80/443 plus UDP 443; do not publish
PostgreSQL, Redis, API, or worker ports. Point the production hostname's A/AAAA records at
the host before asking Caddy to obtain TLS.

Create the deployment environment without copying values into tickets or shell history:

```sh
cp env.example .env
chmod 600 .env
```

Fill every required value:

- Core: `POSTGRES_PASSWORD`, `TOKEN_SECRET`, `APP_BASE_URL=https://<hostname>`,
  `CADDY_BIND_ADDRESS=0.0.0.0`, an immutable `SEAT_SNIPER_IMAGE_TAG`, and
  `ADMISSION_MODE=closed`. Generate a distinct 32–256-character unpadded-base64url
  `PROXY_HEADER_SECRET`; Compose injects the same secret into Caddy and the API.
- Source: a contactable, monitored `FETCH_USER_AGENT`,
  `SOURCE_REQUESTS_PER_SECOND=1`, `SOURCE_VISIBLE_TARGET_SECONDS=120`, and initially
  `KILL_SWITCH=1`. The rate/target are selected production values; the kill switch remains
  fail-closed for the separate live-source and rollout gates.
- Mail: `MAIL_FROM` on the authenticated subdomain, `OPERATOR_EMAIL`,
  `RESEND_API_KEY`, and `RESEND_WEBHOOK_SECRET`. The production Compose model pins
  `MAIL_TRANSPORT=real` and `MAIL_PROVIDER=resend`; it has no noop outbox mount.
- Backup: `BACKUP_REPOSITORY`, `BACKUP_ENCRYPTION_PASSWORD`, storage credentials,
  `BACKUP_INTERVAL_SECONDS=3600`, and a separate `RESTORE_CHECK_PASSWORD`.
- Optional push: either set all of `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and
  `VAPID_SUBJECT`, or leave all three empty.

Production startup rejects noop mail and any non-empty `NOOP_OUTBOX_FILE`. Never set
`DISABLE_RATE_LIMIT=1` or `AUTO_MIGRATE_DEV=1` in production.
`SOURCE_REQUESTS_PER_SECOND` must be exactly `1` for this selected production posture;
the worker also rejects non-finite/non-positive values and anything above 1. The durable
origin limiter applies it across all workers/processes and every physical robots,
class-page, conditional, and redirect attempt. Do not change the rate or the 96-Section
maximum without a recorded project-owner decision and a new spec/capacity/SLO
calculation. Only exact `KILL_SWITCH=0` enables source requests; `1`, missing, empty,
malformed, and every other value remain disabled. Keep the tracked kill switch exactly
`1` until current robots, contactable User-Agent, live-source canary, deployment
configuration, and all other source/rollout gates pass.
`ADMISSION_MODE` defaults to `closed`, but set it explicitly so configuration reviews can
see the posture. An invalid mode fails startup. Do not set `PILOT_INVITE_CODE` until
preparing the pilot; it is required only in `pilot` and must be a high-entropy
32–256-character unpadded-base64url secret (`A–Z a–z 0–9 _ -` only).

In Resend:

1. Verify the sending subdomain and confirm SPF/DKIM alignment.
2. Publish DMARC with reporting; start at the policy approved by the domain owner.
3. Register `https://<hostname>/api/webhooks/resend` for bounce and complaint events.
4. Verify the webhook signing secret matches `RESEND_WEBHOOK_SECRET`.
5. Confirm account quota can sustain the capped pilot before sending a canary.

The webhook's raw request body is capped at exactly 32 KiB by both Caddy and the
application before signature verification or JSON parsing. Do not raise either side
independently.

Compose pins `SOURCE_SAFETY_STOP_FILE` to
`/app/runtime/seat-sniper-source-safety-stop.json` and `SOURCE_ORIGIN_STATE_FILE` to
`/app/runtime/seat-sniper-origin-state.json` in the worker. The worker derives the
exclusive origin fence at `/app/runtime/seat-sniper-origin-state.json.fence`. All three
live on the `runtime_data` volume. A robots disallow or class-page 403/429 creates the
safety-stop marker. Backward-readable origin-state v2 preserves `lastPermitAt` and a
bounded canonical `notBefore`/`notBeforeSetAt` pair, so global spacing and a source
cooldown survive worker recreation. The limiter uses the later of last-start spacing and
`notBefore`, durably reserves before synchronously invoking a physical fetch start, and
reconciles the actual start before normal fence handoff. Reconciliation failure retains
the fence and fails closed. Do not edit, truncate, or remove any of these files manually.
The only supported stop reset is the confirmation-gated CLI in §7, after `KILL_SWITCH=1`
has been persisted and the worker recreated. Reset removes the safety marker/stale fence
only after atomically setting valid `lastPermitAt` to at least reset time without moving a
future boundary backward, while preserving any later cooldown. If origin state is
missing, malformed, or unreadable, reset first attempts an atomic repair with
`lastPermitAt` equal to reset time so the next start still waits the full configured
spacing. If the monotonic update or repair cannot be persisted, reset exits nonzero and
source remains stopped.

For a class-page 429, the worker first writes that effective deadline to origin-state
`notBefore`, then the bounded, non-PII safety marker stores `resumeNotBefore`. The delay
is derived from the greater of exponential backoff and the origin's bounded
`Retry-After`, with jitter and a 24-hour cap. Worker restart/recreation does not erase
either deadline. The explicit reset refuses while the marker deadline is active and
preserves a valid origin deadline. A failure of either write retains the fence. If both
writes fail, no trustworthy deadline exists: keep source disabled and require explicit
review plus a conservative wait before reset.

This is container-recreation durability, not an off-host safety-state backup. The marker
and origin coordination state do **not** survive `docker compose down -v`, explicit
`runtime_data` removal/pruning, or loss of the Docker host. Never remove Compose volumes
or use `down -v` during source incident recovery. Keep the independent `KILL_SWITCH=1`
persisted in deployment configuration before any diagnosis/reset so loss of the volume
cannot silently resume fetching.

## 3. Validate and deploy

Run read-only configuration validation before changing services:

```sh
docker compose config --quiet
docker compose --profile backup --profile restore-check config --quiet
```

Build the immutable application and database-operations images:

```sh
docker compose --profile backup build app backup
```

Deploy in dependency order. Only the one-shot `migrate` service may change schema:

```sh
docker compose up -d db redis
docker compose run --rm migrate
docker compose --profile backup up -d backup
docker compose up -d --no-deps app worker
docker compose up -d --no-deps caddy
docker compose ps
```

Stop if migration exits nonzero. Do not bypass it or start an older image against an
unknown schema. The API intentionally never migrates production on boot.

Check the process-level health reported by Compose, then query liveness and readiness from
inside the private app container:

```sh
docker compose ps
docker compose exec -T app node -e "fetch('http://127.0.0.1:8787/api/health').then(async r=>{console.log(await r.text());process.exit(r.status===200?0:1)}).catch(()=>process.exit(1))"
docker compose exec -T app node -e "fetch('http://127.0.0.1:8787/api/ready').then(async r=>{console.log(r.status,await r.text());process.exit([200,503].includes(r.status)?0:1)}).catch(()=>process.exit(1))"
```

`/api/health` proves only that the API process responds and is the sole app-container
startup gate. `/api/ready` additionally checks PostgreSQL, Redis, unresolved dead-letter
incidents, durable-outbox age, worker/source state, the shared backup-success marker, and
free space on the runtime volume (AC-23). Production requires `DISK_READINESS_PATH` on the
same filesystem as the runtime volume; a missing, unreadable, or below-`HEALTH_DISK_MIN_FREE_KB`
result fails closed and reports NOT READY. The probe deliberately returns only a boolean —
no path and no errno reach the caller.
It correctly returns 503 while `KILL_SWITCH=1`, while the worker is otherwise disabled or
unhealthy, or until the first successful off-host backup replaces the marker. After the
backup succeeds and the risk-accepted source controls are enabled, require readiness 200 before
opening admission. Both paths return 404 through the public Caddy edge.

The worker container health check is liveness only: a fresh heartbeat remains healthy
under the kill switch. Caddy waits only for API liveness and does not depend on aggregate
readiness or worker health, so emailed recovery/manage/unsubscribe routes stay reachable
during a source, backup, or delivery incident.

Inspect logs without exporting them to third parties:

```sh
docker compose logs --since=15m app worker caddy
```

Logs must contain opaque IDs/counts only—never subscriber addresses, tokens, pilot invite
query/header values, push credentials, full watch lists, or fetched HTML. Caddy has no
access log and removes request URIs and headers from runtime error logs; preserve that
property in every edge/logging change.

## 4. Backups and restore checks

The target is an RPO of one hour and an RTO of four hours. These are operational targets,
not proven facts until a timed restore drill succeeds.

Start the continuously scheduled, encrypted off-host backup profile:

```sh
docker compose --profile backup up -d backup
docker compose --profile backup ps backup
docker compose --profile backup logs --since=2h backup
```

The service performs an immediate snapshot and then repeats at
`BACKUP_INTERVAL_SECONDS`. It is unhealthy after `BACKUP_MAX_STALE_SECONDS` without a
success. Only after restic reports success does it atomically replace
`backup_status/success.json` with bounded JSON containing an RFC3339 UTC
`completedAt`. The API mounts that named volume read-only and fails aggregate readiness
when the marker is missing, malformed, future-dated, or stale. Alert on both backup
container health and API readiness; a running container alone does not prove that a
snapshot reached off-host storage.

At least monthly, and before the friends-only pilot opens, restore the newest snapshot into the isolated,
ephemeral restore-check database:

```sh
docker compose --profile restore-check run --rm restore-check
docker compose --profile restore-check rm -sf restore-check-db
```

Success means the newest dump decrypted, restored with `pg_restore --exit-on-error`, and
contained public tables. It does not test application-level correctness or production
failover. Record duration, snapshot timestamp, and result in the release/operations log.

For an actual recovery, never overwrite the only production volume in place. Stop public
writes, retain the affected volume, provision a fresh database target, restore a selected
snapshot there, apply only compatible migrations, run integrity/readiness checks, and
then switch the application. Time that full exercise to substantiate the four-hour RTO.

## 5. Pilot and public admission

Keep `ADMISSION_MODE=closed` and `KILL_SWITCH=1` through infrastructure validation. Closed
mode rejects only new subscription creation with the canonical
`503 admission_unavailable` plus `Retry-After: 3600`; existing resend, confirm,
manage/watch/push, and unsubscribe routes remain usable.

After the owner has cleared the current-robots, User-Agent, safety-stop, live-canary, and
other rollout gates, confirmed there is no future effective source cooldown, and verified
the selected exact rate/target values, recreate the worker with live polling explicitly
enabled:

```sh
# Edit .env: KILL_SWITCH=0 (exactly)
docker compose up -d --no-deps --force-recreate worker
docker compose exec -T worker node -e "if(process.env.KILL_SWITCH!=='0')process.exit(1);const r=Number(process.env.SOURCE_REQUESTS_PER_SECOND);const t=Number(process.env.SOURCE_VISIBLE_TARGET_SECONDS);if(r!==1||t!==120)process.exit(1);console.log(JSON.stringify({event:'source_enable_config_verified',requestsPerSecond:r,sourceVisibleTargetSeconds:t,maxUniqueSections:96}))"
docker compose logs --since=5m worker
```

Private `/api/health` must stay 200 across this transition. Private `/api/ready` changes
from the expected disabled 503 to 200 only when the source cycle, dependencies, outbox,
dead-letter state, and backup marker are all operational.

To open the closed pilot:

1. Generate a new high-entropy 32–256-character unpadded-base64url bearer (`A–Z a–z
0–9 _ -` only) in a secret manager or other non-logged channel. Do not paste it into a
   ticket, shell history, public chat, URL shortener, analytics link, or third-party link
   tracker.
2. Set `ADMISSION_MODE=pilot` and `PILOT_INVITE_CODE=<bearer>` in the protected deployment
   environment, then recreate the app. The API compares digests timing-safely; it never
   stores or logs the raw code.
3. Privately send invited people
   `https://<hostname>/?invite=<urlencoded-bearer>`. This is shared bearer access, not a
   personal invitation: anyone who obtains it and controls an exact Berkeley mailbox can
   request a slot. The first-party client immediately removes the query from browser
   history, retains it only for that tab's session, sends it as
   `x-seat-sniper-invite-code`, and clears it after a successful create.
4. Verify correct-code admission in a controlled inbox and verify a wrong/missing code
   gets the same 503/body/Retry-After. Do not record either code in evidence. Verify the
   concurrency test for the atomic 100-row cap has passed on real PostgreSQL; do not
   manufacture 100 production accounts for a manual check.

Use that first correct-code admission for the owner-controlled source canary and real
`@berkeley.edu` inbox journey: subscribe, receive, explicitly confirm, inspect freshness,
receive a controlled alert, resend a manage link, and unsubscribe. Record timestamps and
headers; do not put the address, invite, or bearer links in the release ticket.

The pilot lasts at least two weeks and is capped atomically at 100 current Pending +
Confirmed Subscriber rows and 96 distinct activated live Sections under the selected
one-global-request/second ceiling. Unsubscribe and the 72-hour Pending purge release
account slots. Measure physical request mix—including robots/redirect overhead—cache
behavior, and source-visible p95. If the 120-second target is not sustained, reduce
admission/capacity; never exceed one physical Berkeley-origin request/second. The pilot
uses the full production flow; there is no double-opt-in or suppression bypass.

**Public admission is NOT a v1 goal (owner decision 2026-07-30; spec §2 Rollout posture,
ADR 0009 amendment).** This service is local first, then friends-only by invitation, and
`pilot` is the terminal admission mode for v1. Do not run the promotion below as part of any
planned rollout — it is retained only so the procedure and its bar are on record should the
decision ever be revisited. An unmet item in this list is NOT outstanding v1 work.

If that decision is ever revisited, open public admission only after:

- all AC-1–AC-35 evidence is current (AC-24 is CONDITIONAL — see spec §7);
- restore, source, and inbox canaries pass;
- source-visible notification p95 is below two minutes throughout the pilot;
- outbox age, bounce, complaint, and provider-quota trends are healthy;
- rollback and kill-switch procedures have been exercised.

Then set `ADMISSION_MODE=public`, remove `PILOT_INVITE_CODE` from the deployment
environment, recreate the app, and verify a create without the invite header. Public mode
still requires exact Berkeley mailbox double opt-in and enforces abuse/source-capacity
limits; it does not prove enrollment.

Note that none of this relaxes the PILOT bar. Friends-only lowers the audience, not the
gates: real mail transport, double opt-in, authenticated SPF/DKIM/DMARC, robots/ToS
confirmation, the source-safety stop, and a monitored Operator inbox all still apply before
a single invitation goes out. The Operator inbox is assigned as of 2026-08-25 (ADR 0010): one
Operator, no backup, on a push-filtered alias, responding best-effort within waking hours. The
blocker that replaced it is Blind-window disclosure, and it is still OPEN — no invitation goes
out until a 60-minute unreadable Section emails its watchers exactly once.

## 6. Deploy and rollback

Before each release, confirm a fresh off-host snapshot and record the current immutable
image tag. Build the new tag, run the one-shot migration, then recreate app and worker.
Keep Caddy and the data services running unless their configuration changed.

For an application rollback, select the recorded previous image tag and recreate app and
worker:

```sh
SEAT_SNIPER_IMAGE_TAG=<previous-tag> docker compose up -d --no-deps --force-recreate app worker
```

Then run private readiness and the noop/controlled smoke appropriate to the environment.
Do not run a down-migration. v0.4 migrations are expected to remain compatible with the
previous application during rollback; if a particular release violates that rule, block
deployment until it has an explicit restore/fix-forward plan.

To halt source traffic without discarding queued mail or taking user recovery ingress
offline:

```sh
# Edit .env: KILL_SWITCH=1
docker compose up -d --no-deps --force-recreate worker
docker compose logs --since=5m worker
```

The worker continues its independently scheduled mail-dispatch and retention loops, but
publishes `disabled: true`; aggregate readiness returns 503 while process/container
liveness remains healthy.

If traffic must stop immediately, `docker compose stop worker` is the emergency brake,
but it also pauses mail dispatch and retention sweeps. Restore the worker promptly after
the source incident is contained.

To stop only new Subscriber creation while preserving existing access and mail work, set
`ADMISSION_MODE=closed` and recreate the app. This is the rollout/abuse brake; it does not
replace `KILL_SWITCH`, which controls source fetches.

## 7. Incidents

### Parser/source failure

1. A robots disallow or class-page 403/429 must abort the remaining source cycle and
   engage the worker's source-safety stop. Also set `KILL_SWITCH=1` immediately if those
   signals appear, Berkeley asks the service to stop, observed origin errors/latency
   correlate with polling, or continued fetching could exceed the configured ceiling.
2. Persist both `ADMISSION_MODE=closed` and `KILL_SWITCH=1` in `.env`. Recreate the app
   first, before diagnosis or reset, so no new Subscriber can add demand during the
   incident:

   ```sh
   docker compose up -d --no-deps --force-recreate app
   docker compose logs --since=5m app
   ```

   Verify a controlled new create receives the canonical `503 admission_unavailable`.
   Using an existing controlled Subscriber without copying its address or token into
   logs/tickets, verify its manage view and resend/recovery journey remain reachable;
   closed admission must not lock out existing users. Then recreate the worker:

   ```sh
   docker compose up -d --no-deps --force-recreate worker
   docker compose logs --since=5m worker
   ```

   Confirm the worker reports source disabled. This manual brake is independent of the
   durable `SOURCE_SAFETY_STOP_FILE`; both protections remain in place during diagnosis.
   Do not use `docker compose down -v`, prune `runtime_data`, or otherwise destroy source
   safety state.

3. Diagnose the trigger while source fetching stays disabled. Record a current robots
   evaluation for the exact content path, determine why the origin returned 403/429 or
   showed harm, and review the configured global rate against current capacity and the
   source-visible SLO. Open the exact public class URL manually only if that controlled
   request is appropriate. A real 404/class-gone is normal lifecycle; a 200 page with
   changed labels/identity is a parser incident. Preserve only sanitized fixtures.

   Inspect only the marker's fixed classification/timestamps and the origin state's
   non-PII timing fields:

   ```sh
   docker compose exec -T worker node -e "const fs=require('node:fs');const p=process.env.SOURCE_SAFETY_STOP_FILE;const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;if(!p)process.exit(1);if(!fs.existsSync(p)){console.log(JSON.stringify({event:'source_safety_stop_marker',state:'absent'}));process.exit(0)}if(!fs.lstatSync(p).isFile())process.exit(1);const m=JSON.parse(fs.readFileSync(p,'utf8'));const keys=Object.keys(m).sort().join(',');const reasons=new Set(['robots_disallow','source_forbidden','source_rate_limited']);const legacy=m.version===1&&keys==='reason,stoppedAt,version';const delay=Date.parse(m.resumeNotBefore)-Date.parse(m.stoppedAt);const current=m.version===2&&keys==='reason,resumeNotBefore,stoppedAt,version'&&(m.reason==='source_rate_limited'?(iso(m.resumeNotBefore)&&delay>=0&&delay<=86400000):m.resumeNotBefore===null);if(!reasons.has(m.reason)||!iso(m.stoppedAt)||!(legacy||current))process.exit(1);console.log(JSON.stringify({event:'source_safety_stop_marker',version:m.version,reason:m.reason,stoppedAt:m.stoppedAt,resumeNotBefore:m.resumeNotBefore??null}))"
   docker compose exec -T worker node -e "const fs=require('node:fs');const p=process.env.SOURCE_ORIGIN_STATE_FILE;const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;const owner=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);if(!p)process.exit(1);if(!fs.existsSync(p)){console.log(JSON.stringify({event:'source_origin_state',state:'absent',fencePresent:fs.existsSync(p+'.fence')}));process.exit(0)}if(!fs.lstatSync(p).isFile())process.exit(1);const m=JSON.parse(fs.readFileSync(p,'utf8'));const keys=Object.keys(m).sort().join(',');const legacy=m.version===1&&keys==='lastPermitAt,ownerToken,version';const pair=m.notBefore===null&&m.notBeforeSetAt===null;const bounded=iso(m.notBefore)&&iso(m.notBeforeSetAt)&&Date.parse(m.notBefore)>=Date.parse(m.notBeforeSetAt)&&Date.parse(m.notBefore)-Date.parse(m.notBeforeSetAt)<=86400000;const current=m.version===2&&keys==='lastPermitAt,notBefore,notBeforeSetAt,ownerToken,version'&&(pair||bounded);if(!owner(m.ownerToken)||!iso(m.lastPermitAt)||!(legacy||current))process.exit(1);console.log(JSON.stringify({event:'source_origin_state',version:m.version,lastPermitAt:m.lastPermitAt,notBefore:m.notBefore??null,notBeforeSetAt:m.notBeforeSetAt??null,fencePresent:fs.existsSync(p+'.fence')}))"
   ```

   A 429 normally has both marker `resumeNotBefore` and origin-state `notBefore`. Record
   both in UTC and use the later deadline. It already includes the effective bounded
   worker recovery delay / bounded origin `Retry-After`; restart or recreation cannot
   shorten it. If one deadline is absent because its persistence failed, the other plus
   the retained fence remains fail-closed. If neither is trustworthy, do not infer
   eligibility: keep `KILL_SWITCH=1` and admission closed, review the failure, and wait
   at least the full 24-hour maximum from the observed 429 before considering reset. If a
   file is malformed or unreadable, inspection fails and fetching remains closed—never
   replace/delete it by hand.

4. After the later persisted deadline (when present), or the documented conservative
   wait for dual persistence failure, and explicit Operator review all permit clearing
   the latch, run the reset **inside the worker container that mounts the production
   `runtime_data` volume**:

   ```sh
   date -u +'%Y-%m-%dT%H:%M:%SZ' # record reset lower bound in incident evidence
   docker compose exec -T worker npx tsx src/worker/source-safety-stop-cli.ts RESET_SOURCE_SAFETY_STOP
   ```

   The CLI requires exact `KILL_SWITCH=1`. A reset attempted before a persisted 429
   deadline exits nonzero with
   `{"event":"source_safety_stop_reset_failed","classification":"resume_deadline_active"}`
   and leaves the marker in place, including after restart. Wait for the deadline rather
   than trying to bypass it.

   A successful command emits the fixed `source_safety_stop_reset` /
   `operator_confirmed` event, removes the safety marker and any stale
   `${SOURCE_ORIGIN_STATE_FILE}.fence`, and leaves valid
   `SOURCE_ORIGIN_STATE_FILE.lastPermitAt` no earlier than both its pre-reset value and
   reset time, preserving any later cooldown. If origin state was missing, malformed, or
   unreadable, reset first atomically replaces it with valid state whose `lastPermitAt`
   is reset time and whose cooldown is clear. If the monotonic update or repair is not
   possible, reset exits nonzero and leaves source stopped. Any nonzero exit leaves
   recovery blocked; do not delete any source-state file by hand.

5. Verify the marker/fence are absent, origin state has valid last-permit and optional
   cooldown timestamps, and the manual kill switch is still active:

   ```sh
   docker compose exec -T worker node -e "const fs=require('node:fs');const stop=process.env.SOURCE_SAFETY_STOP_FILE;const state=process.env.SOURCE_ORIGIN_STATE_FILE;const fence=state+'.fence';const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;const owner=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);if(!stop||!state||fs.existsSync(stop)||fs.existsSync(fence)||!fs.existsSync(state)||!fs.lstatSync(state).isFile())process.exit(1);const m=JSON.parse(fs.readFileSync(state,'utf8'));const keys=Object.keys(m).sort().join(',');const legacy=m.version===1&&keys==='lastPermitAt,ownerToken,version';const pair=m.notBefore===null&&m.notBeforeSetAt===null;const bounded=iso(m.notBefore)&&iso(m.notBeforeSetAt)&&Date.parse(m.notBefore)>=Date.parse(m.notBeforeSetAt)&&Date.parse(m.notBefore)-Date.parse(m.notBeforeSetAt)<=86400000;const current=m.version===2&&keys==='lastPermitAt,notBefore,notBeforeSetAt,ownerToken,version'&&(pair||bounded);if(!owner(m.ownerToken)||!iso(m.lastPermitAt)||!(legacy||current))process.exit(1);console.log(JSON.stringify({event:'source_recovery_state_verified',version:m.version,lastPermitAt:m.lastPermitAt,notBefore:m.notBefore??null,notBeforeSetAt:m.notBeforeSetAt??null}))"
   docker compose exec -T worker node -e "if(process.env.KILL_SWITCH!=='1')process.exit(1);console.log('source remains disabled')"
   ```

   If pre-reset origin state was valid, verify reported `lastPermitAt` is no earlier than
   both its pre-reset value and the recorded reset lower bound; a future boundary must
   never move backward. Verify any later pre-reset `notBefore`/`notBeforeSetAt` cooldown
   is unchanged. If state was missing/malformed/unreadable and reset succeeded, verify
   `lastPermitAt` corresponds to reset time and the cooldown pair is null; this
   reinitialization forces one full configured spacing interval before a new start. If
   reset exited nonzero, leave every source-state file in place and keep source stopped.
   Aggregate readiness must remain 503/disabled at this point. Marker reset alone must
   never resume source traffic. Do not remove `SOURCE_ORIGIN_STATE_FILE`.

6. Only after the review, current robots/rate evidence, parser tests where applicable,
   and the cleared-marker/disabled checks are recorded may the Operator set
   exact `KILL_SWITCH=0` and recreate the worker. Before changing it, verify exact
   `SOURCE_REQUESTS_PER_SECOND=1` and `SOURCE_VISIBLE_TARGET_SECONDS=120`. If deployment
   drifted, correct those values while `KILL_SWITCH=1` and recreate the still-disabled
   worker before this check:

   ```sh
   # If required, restore the selected rate/target while KILL_SWITCH=1, then:
   docker compose up -d --no-deps --force-recreate worker
   docker compose exec -T worker node -e "const r=Number(process.env.SOURCE_REQUESTS_PER_SECOND);const t=Number(process.env.SOURCE_VISIBLE_TARGET_SECONDS);if(r!==1||t!==120)process.exit(1);console.log(JSON.stringify({event:'source_rate_verified',requestsPerSecond:r,sourceVisibleTargetSeconds:t,maxUniqueSections:96}))"
   # Edit .env: KILL_SWITCH=0
   docker compose up -d --no-deps --force-recreate worker
   docker compose exec -T worker node -e "if(process.env.KILL_SWITCH!=='0')process.exit(1);console.log('source explicitly enabled')"
   docker compose logs --since=5m worker
   ```

   Missing, empty, boolean-looking, or any other kill-switch value remains disabled; do
   not substitute `false` for exact `0`.
   Observe a controlled source cycle and readiness while admission remains `closed`. Any
   new robots disallow or class-page 403/429 engages a new durable stop; repeat this
   entire sequence rather than resetting around it.

7. Reopen admission only after the source recovery review signs off on the controlled cycle,
   current robots/rate evidence, readiness, and continued manage/recovery access. Restore the
   intended `ADMISSION_MODE` (and a valid `PILOT_INVITE_CODE`), recreate the app, and verify
   admission deliberately. For v1 the intended mode is `pilot`; `public` is not a v1 mode
   (owner decision 2026-07-30) and recovering into it would silently widen admission beyond
   the friends-only posture:

   ```sh
   # Edit .env: ADMISSION_MODE=pilot   (v1; see §"Hard launch blockers")
   docker compose up -d --no-deps --force-recreate app
   docker compose logs --since=5m app
   ```

   Clearing a marker or seeing one healthy source cycle never reopens admission by
   itself.

### Readiness or outbox failure

- Query private `/api/ready` and inspect non-PII app/worker logs.
- For PostgreSQL/Redis failure, restore that dependency; do not disable shared rate limits
  or suppression checks to force traffic through.
- For a DISK check failure (AC-23), free space on the runtime volume or grow it, then
  re-query readiness. Confirm `DISK_READINESS_PATH` still points at the mounted runtime
  filesystem and `HEALTH_DISK_MIN_FREE_KB` is the intended floor. Do NOT unset
  `DISK_READINESS_PATH` to clear the 503 — production startup requires it, and removing the
  probe hides eroding headroom instead of fixing it. The API stays live throughout so manage
  and recovery ingress remain reachable.
- For old queued mail, check Resend status/quota and `Retry-After`. Do not bulk-delete or
  manually replay jobs. One-hour opening alerts expire; permanent failures dead-letter.
- A suppression lookup failure is fail-closed for that attempt. Never bypass it.

### Dead-letter incident acknowledgement and resolution

Dead-letter incidents are surfaced through the Operator channel outside `mail_outbox`.
The notification and the worker's `dead_letter_incident_*` structured events carry an
opaque incident UUID. Publication retries use the stable key
`dead-letter/<incident-uuid>`; `surfaced_at` is stamped only after the Operator channel
accepts that event. Do not manually set `surfaced_at` and do not create an Operator mail
job for a failed Operator job.

Use only an authenticated OS/SSH session on the deployment host. The Docker/OS access
boundary is the authorization check; there is deliberately no public or private HTTP
control route. Copy only the opaque incident UUID from the Operator notification, then
inspect its bounded lifecycle and failure classifications:

```sh
INCIDENT_ID='<incident-uuid>'
docker compose exec -T db psql --no-psqlrc -U seatsniper -d seatsniper \
  --set=incident_id="$INCIDENT_ID" \
  --command "SELECT i.id, i.state, i.opened_at, i.surfaced_at, i.acknowledged_at, i.resolved_at, m.kind, m.terminal_reason, m.last_error_code FROM dead_letter_incidents AS i JOIN mail_outbox AS m ON m.id = i.mail_job_id WHERE i.id = :'incident_id';"
```

This query intentionally excludes subscriber identifiers, addresses, class keys, and
`mail_outbox.payload`. Never inspect or paste those fields into incident systems. Check
the mail provider using its own restricted Operator console and the opaque classifications
above; do not manually replay or mutate an outbox row.

After accepting ownership, acknowledge an `unresolved` incident from the production app
container:

```sh
docker compose exec -T app npm --silent run db:incident -- acknowledge "$INCIDENT_ID"
```

Acknowledgement clears the unresolved readiness failure but retains the incident and its
referenced job. It does not replay or resolve delivery. After remediation or an explicitly
controlled replay is complete, resolve an `unresolved` or `acknowledged` incident:

```sh
docker compose exec -T app npm --silent run db:incident -- resolve "$INCIDENT_ID"
```

The CLI accepts exactly one action and one UUID. It prints only a fixed success, rejection,
usage, or failure line; it never echoes input or database errors. Exit `0` means the
requested transition committed. Any nonzero exit means invalid input, a missing incident,
an invalid current state, or an operational failure. Re-inspect the bounded lifecycle
columns before retrying. Resolution does not itself replay mail and makes a sufficiently
old referenced job eligible for the normal retention sweep.

### Backup/storage failure

- Page when the backup container is unhealthy or the newest off-host snapshot exceeds the
  one-hour RPO.
- Preserve the last good repository and its encryption keys. Fix credentials/network
  access, trigger the backup profile, then run the isolated restore check.
- If database free space approaches `HEALTH_DISK_MIN_FREE_KB`, stop admission/source work
  and increase storage before PostgreSQL becomes unavailable.

## 8. Key rotation

Schedule rotations, retain a tested rollback credential where the provider allows it, and
recreate both app and worker after changing shared mail/token configuration.

- **Resend API key:** create the new key, update `.env`, recreate app/worker, perform a
  controlled inbox send, then revoke the old key.
- **Webhook secret:** update the Resend endpoint and `.env` as one maintenance action,
  recreate app/worker, and verify a signed test event before considering it complete.
- **Proxy-hop secret:** generate a fresh value, update `PROXY_HEADER_SECRET`, and recreate
  Caddy and app in one maintenance action. Requests through a mismatched pair deliberately
  ignore forwarded addresses, so verify the shared rate-limit identity after rotation.
- **Token secret:** rotation invalidates every outstanding confirm/manage link. Use it for
  compromise response or a planned event; communicate that confirmed users can request a
  fresh link, update `.env`, then recreate app/worker.
- **Pilot invite code:** treat it as shared bearer access. On leak or audience change,
  generate a fresh code, update `PILOT_INVITE_CODE`, and recreate the app. Privately issue
  a new URL; never reuse the old code or put either value in logs/tickets. Rotation does
  not affect Confirmed Subscribers or their manage links.
- **PostgreSQL password:** use an interactive `psql` password change so the new secret
  never enters shell history, update `.env`, and recreate database clients. Verify backup
  and restore-check access afterward.
- **Restic encryption credentials:** add and verify a new repository key before removing
  the old one. Never merely replace the password and risk losing access to all snapshots.
- **VAPID keys:** rotating them can invalidate existing browser subscriptions; expect
  users to enable push again. Email remains the durable baseline.

After any rotation, rerun private readiness, provider/webhook checks, and a backup restore
check when the rotated credential affects data recovery.
