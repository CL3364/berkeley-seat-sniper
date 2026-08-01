#!/bin/bash
# Lead acceptance spot-check for the v0.4 HTTP surface.
#
# The test-only server composes the production API, migrations, repository,
# durable mail outbox, dispatcher, and one worker drain in a single process.
# That preserves the real "API commits a job; worker sends it" boundary while
# allowing an isolated PGlite database for a local release check.
set -u
set -o pipefail
cd "$(dirname "$0")/.."

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/seat-sniper-acceptance.XXXXXX")"
OUTBOX="$RUN_DIR/noop-outbox.ndjson"
SRVLOG="$RUN_DIR/server.log"
BODY_FILE="$RUN_DIR/body.json"
HEADERS_FILE="$RUN_DIR/headers.txt"
SRV=""

cleanup() {
  if [ -n "$SRV" ]; then
    kill "$SRV" 2>/dev/null || true
    wait "$SRV" 2>/dev/null || true
  fi
  rm -rf -- "$RUN_DIR"
}
trap cleanup EXIT INT TERM

PASS=0
FAIL=0
ok() {
  PASS=$((PASS + 1))
  echo "PASS: $1"
}
bad() {
  FAIL=$((FAIL + 1))
  echo "FAIL: $1"
}

PORT=8791 \
  NODE_ENV=test \
  SKIP_ENV_FILE=1 \
  ADMISSION_MODE=public \
  DATABASE_URL= \
  REDIS_URL= \
  TOKEN_SECRET="acceptance-check-secret-0123456789abcdef" \
  MAIL_TRANSPORT=noop \
  MAIL_PROVIDER= \
  RESEND_API_KEY= \
  RESEND_WEBHOOK_SECRET= \
  NOOP_OUTBOX_FILE="$OUTBOX" \
  APP_BASE_URL="http://127.0.0.1:8791" \
  VAPID_PUBLIC_KEY= \
  VAPID_PRIVATE_KEY= \
  VAPID_SUBJECT= \
  TRUST_PROXY=0 \
  SOURCE_REQUESTS_PER_SECOND=1 \
  SOURCE_VISIBLE_TARGET_SECONDS=2 \
  npx tsx e2e/server.ts >"$SRVLOG" 2>&1 &
SRV=$!

for _ in $(seq 1 80); do
  curl -sf http://127.0.0.1:8791/api/health >/dev/null 2>&1 && break
  sleep 0.25
done
if ! curl -sf http://127.0.0.1:8791/api/health >/dev/null; then
  bad "server did not become healthy"
  sed -n '1,120p' "$SRVLOG"
  exit 1
fi
ok "liveness is healthy on the isolated acceptance server"

if curl -sf http://127.0.0.1:8791/api/ready >/dev/null; then
  ok "database, limiter, and durable outbox readiness is healthy"
else
  bad "readiness probe did not become healthy"
fi

request() {
  curl -sS -o "$BODY_FILE" -D "$HEADERS_FILE" -w "%{http_code}" "$@"
}

wait_for_outbox() {
  local kind="$1"
  local email="$2"
  for _ in $(seq 1 100); do
    if [ -f "$OUTBOX" ] && grep -F "\"kind\":\"$kind\"" "$OUTBOX" | grep -Fq "\"to\":\"$email\""; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

extract_token() {
  local kind="$1"
  local email="$2"
  local parameter="$3"
  grep -F "\"kind\":\"$kind\"" "$OUTBOX" \
    | grep -F "\"to\":\"$email\"" \
    | tail -1 \
    | grep -o "${parameter}=[A-Za-z0-9._~-]*" \
    | head -1 \
    | cut -d= -f2
}

CLASS_KEY="2026-fall-compsci-189-001-lec-001"
OTHER_CLASS_KEY="2026-fall-data-100-001-grp-001"
PRIMARY_EMAIL="accept1@berkeley.edu"
PENDING_EMAIL="accept2@berkeley.edu"
CAPACITY_EMAIL="capacity@berkeley.edu"

# AC-2 / AC-21: reject a lookalike mailbox and an oversized body canonically.
CODE=$(request -X POST http://127.0.0.1:8791/api/subscriptions \
  -H 'content-type: application/json' \
  -d "{\"email\":\"student@berkeley.edu.example\",\"classKeys\":[\"$CLASS_KEY\"]}")
BODY=$(cat "$BODY_FILE")
if [ "$CODE" = "400" ] && echo "$BODY" | grep -q '"validation_error"'; then
  ok "AC-2: a Berkeley lookalike domain is rejected"
else
  bad "AC-2: lookalike mailbox returned $CODE $BODY"
fi

CODE=$(head -c 70000 </dev/zero \
  | tr '\0' 'a' \
  | curl -sS -o "$BODY_FILE" -D "$HEADERS_FILE" -w "%{http_code}" \
    -X POST http://127.0.0.1:8791/api/subscriptions \
    -H 'content-type: application/json' \
    --data-binary @-)
BODY=$(cat "$BODY_FILE")
if [ "$CODE" = "413" ] && echo "$BODY" | grep -q '"payload_too_large"'; then
  ok "AC-21: an oversized request is rejected before JSON parsing"
else
  bad "AC-21: oversized request returned $CODE $BODY"
fi

# AC-1: subscribe commits a pending row and durable confirmation job without
# leaking the subscriber id or signed token in the response.
CODE=$(request -X POST http://127.0.0.1:8791/api/subscriptions \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$PRIMARY_EMAIL\",\"classKeys\":[\"$CLASS_KEY\"]}")
BODY=$(cat "$BODY_FILE")
if [ "$CODE" = "202" ] && [ "$BODY" = '{"status":"pending"}' ]; then
  ok "AC-1: subscribe returns 202 pending"
else
  bad "AC-1: subscribe returned $CODE $BODY"
fi
if echo "$BODY" | grep -qiE 'token|subscriberId|watches'; then
  bad "AC-1: subscribe response leaks protected state"
else
  ok "AC-1: subscribe response carries no token, subscriber id, or watches"
fi

# AC-2b: duplicate subscription is conflict-shaped and leaks no identity.
CODE=$(request -X POST http://127.0.0.1:8791/api/subscriptions \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$PRIMARY_EMAIL\",\"classKeys\":[\"$CLASS_KEY\"]}")
BODY=$(cat "$BODY_FILE")
if [ "$CODE" = "409" ] \
  && echo "$BODY" | grep -q '"error"' \
  && ! echo "$BODY" | grep -qiE 'token|subscriberId|watches'; then
  ok "AC-2b: duplicate subscription returns a non-leaking 409"
else
  bad "AC-2b: duplicate subscription returned $CODE $BODY"
fi

if wait_for_outbox confirmation "$PRIMARY_EMAIL"; then
  TOKEN=$(extract_token confirmation "$PRIMARY_EMAIL" confirm)
else
  TOKEN=""
fi
if [ -n "$TOKEN" ]; then
  ok "AC-1: the worker dispatched the durable confirmation job"
else
  bad "AC-1: no extractable confirmation link reached the noop mailbox"
  TOKEN=missing
fi

# AC-10 and AC-1 tail: confirmation is idempotent and unlocks manage state.
C1=$(request -X POST -H 'content-type: application/json' -d '{}' \
  "http://127.0.0.1:8791/api/subscriptions/$TOKEN/confirm")
C2=$(request -X POST -H 'content-type: application/json' -d '{}' \
  "http://127.0.0.1:8791/api/subscriptions/$TOKEN/confirm")
if [ "$C1" = "200" ] && [ "$C2" = "200" ]; then
  ok "AC-10: confirming the same link twice is idempotent"
else
  bad "AC-10: confirmation returned $C1 then $C2"
fi

CODE=$(request "http://127.0.0.1:8791/api/subscriptions/$TOKEN")
BODY=$(cat "$BODY_FILE")
if [ "$CODE" = "200" ] \
  && echo "$BODY" | grep -q '"confirmed":true' \
  && echo "$BODY" | grep -q "$CLASS_KEY"; then
  ok "AC-1: confirmed manage state contains the requested watch"
else
  bad "AC-1: manage state returned $CODE $BODY"
fi

# AC-11: recovery is non-enumerating; only the known address produces work.
R1=$(curl -sS -X POST http://127.0.0.1:8791/api/subscriptions/resend \
  -H 'content-type: application/json' -d "{\"email\":\"$PRIMARY_EMAIL\"}")
R2=$(curl -sS -X POST http://127.0.0.1:8791/api/subscriptions/resend \
  -H 'content-type: application/json' -d '{"email":"nobody-here@berkeley.edu"}')
if [ "$R1" = "$R2" ] && [ "$R1" = '{"status":"sent"}' ]; then
  ok "AC-11: known and unknown recovery responses are byte-identical"
else
  bad "AC-11: recovery responses differ: '$R1' vs '$R2'"
fi
if wait_for_outbox manage-link "$PRIMARY_EMAIL"; then
  ok "AC-11: a known confirmed address receives a manage-link job"
else
  bad "AC-11: the known address did not receive a manage link"
fi
if [ -f "$OUTBOX" ] && grep -Fq '"to":"nobody-here@berkeley.edu"' "$OUTBOX"; then
  bad "AC-11: an unknown address produced outbound mail"
else
  ok "AC-11: an unknown address produces no outbound mail"
fi

# AC-18: Pending watches consume no source capacity. Activating a different
# unique source is rejected with a stable 503 and Retry-After while the
# existing confirmed watch remains usable and the rejected subscriber remains
# Pending.
CODE=$(request -X POST http://127.0.0.1:8791/api/subscriptions \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$CAPACITY_EMAIL\",\"classKeys\":[\"$OTHER_CLASS_KEY\"]}")
BODY=$(cat "$BODY_FILE")
if [ "$CODE" = "202" ] && [ "$BODY" = '{"status":"pending"}' ]; then
  ok "AC-18: a Pending staged watch consumes no source capacity"
else
  bad "AC-18: staged capacity request returned $CODE $BODY"
fi
if wait_for_outbox confirmation "$CAPACITY_EMAIL"; then
  CAPACITY_TOKEN=$(extract_token confirmation "$CAPACITY_EMAIL" confirm)
else
  CAPACITY_TOKEN=""
fi
CODE=$(request -X POST -H 'content-type: application/json' -d '{}' \
  "http://127.0.0.1:8791/api/subscriptions/$CAPACITY_TOKEN/confirm")
BODY=$(cat "$BODY_FILE")
if [ "$CODE" = "503" ] \
  && echo "$BODY" | grep -q '"capacity_exceeded"' \
  && grep -qi '^Retry-After:' "$HEADERS_FILE"; then
  ok "AC-18: confirmation capacity returns 503 plus Retry-After"
else
  bad "AC-18: capacity confirmation returned $CODE $BODY"
fi
CODE=$(request "http://127.0.0.1:8791/api/subscriptions/$CAPACITY_TOKEN")
BODY=$(cat "$BODY_FILE")
if [ "$CODE" = "200" ] \
  && echo "$BODY" | grep -q '"confirmed":false' \
  && echo "$BODY" | grep -q "$OTHER_CLASS_KEY"; then
  ok "AC-18: rejected capacity confirmation remains wholly Pending"
else
  bad "AC-18: rejected capacity state returned $CODE $BODY"
fi

# AC-16c: a Pending subscriber cannot register push; unconfigured VAPID is
# advertised truthfully.
curl -sS -X POST http://127.0.0.1:8791/api/subscriptions \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$PENDING_EMAIL\",\"classKeys\":[\"$CLASS_KEY\"]}" >/dev/null
if wait_for_outbox confirmation "$PENDING_EMAIL"; then
  PENDING_TOKEN=$(extract_token confirmation "$PENDING_EMAIL" confirm)
else
  PENDING_TOKEN=""
fi
CODE=$(request -X POST "http://127.0.0.1:8791/api/subscriptions/$PENDING_TOKEN/push" \
  -H 'content-type: application/json' \
  -d '{"endpoint":"https://push.example.com/ep1","keys":{"p256dh":"BL7ELU24fJTAlH5Kyl8N6BDCac8u8li_U5PIwG963MOvdYs9s7LSzj8x_7v7RFdLZ9Eap50PiiyF5K0TDAis7t0","auth":"AAAAAAAAAAAAAAAAAAAAAA"}}')
if [ "$CODE" = "409" ]; then
  ok "AC-16c: a Pending subscriber cannot enable push"
else
  bad "AC-16c: Pending push registration returned $CODE"
fi
VAPID=$(curl -sS http://127.0.0.1:8791/api/push/vapid-public-key)
if [ "$VAPID" = '{"publicKey":null}' ]; then
  ok "AC-16c: the API reports push unavailable when VAPID is unset"
else
  bad "AC-16c: unexpected VAPID response $VAPID"
fi

# AC-7: unsubscribe destroys access and the watched rows.
CODE=$(request -X POST "http://127.0.0.1:8791/api/subscriptions/$TOKEN/unsubscribe")
if [ "$CODE" = "204" ]; then
  ok "AC-7: one-click unsubscribe returns 204"
else
  bad "AC-7: unsubscribe returned $CODE"
fi
CODE=$(request "http://127.0.0.1:8791/api/subscriptions/$TOKEN")
if [ "$CODE" = "404" ]; then
  ok "AC-7: the old manage link returns 404 after unsubscribe"
else
  bad "AC-7: manage after unsubscribe returned $CODE"
fi

# AC-8: structured application logs must not contain mailbox addresses or tokens.
if grep -Fq '@berkeley.edu' "$SRVLOG"; then
  bad "AC-8: a subscriber address appears in application logs"
else
  ok "AC-8: application logs contain no subscriber address"
fi
if [ "$TOKEN" != "missing" ] && grep -Fq "$TOKEN" "$SRVLOG"; then
  bad "AC-8: a signed manage token appears in application logs"
else
  ok "AC-8: application logs contain no signed manage token"
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
