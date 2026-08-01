CREATE TABLE "mail_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subscriber_id" text,
	"class_key" text,
	"opened_at" timestamp with time zone,
	"reason" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"claim_token" text,
	"sent_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"terminal_reason" text,
	"provider_idempotency_key" text NOT NULL,
	"provider_message_id" text,
	"provider_accepted_at" timestamp with time zone,
	"last_error_code" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "mail_outbox_provider_idempotency_uq" UNIQUE("provider_idempotency_key"),
	CONSTRAINT "mail_outbox_kind_valid" CHECK ("mail_outbox"."kind" in ('alert', 'confirmation', 'manage-link', 'operator')),
	CONSTRAINT "mail_outbox_status_valid" CHECK ("mail_outbox"."status" in ('queued', 'processing', 'sent', 'cancelled', 'dead_letter')),
	CONSTRAINT "mail_outbox_terminal_reason_valid" CHECK ("mail_outbox"."terminal_reason" is null or "mail_outbox"."terminal_reason" in (
        'opening-closed',
        'expired',
        'permanent-failure',
        'retry-horizon',
        'subscriber-ineligible',
        'suppressed'
      )),
	CONSTRAINT "mail_outbox_class_key_valid" CHECK ("mail_outbox"."class_key" is null or "mail_outbox"."class_key" ~ '^[0-9]{4}-(fall|spring|summer)-[a-z0-9]{1,32}-[a-z0-9]{1,32}-((?=[a-z0-9]{1,8}-)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})-[a-z]{2,8}-((?=[a-z0-9]{1,8}$)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})$'),
	CONSTRAINT "mail_outbox_shape_valid" CHECK ((
          "mail_outbox"."kind" = 'alert'
          and "mail_outbox"."subscriber_id" is not null
          and "mail_outbox"."class_key" is not null
          and "mail_outbox"."opened_at" is not null
          and "mail_outbox"."reason" is not null
          and "mail_outbox"."expires_at" = "mail_outbox"."opened_at" + interval '1 hour'
        ) or (
          "mail_outbox"."kind" in ('confirmation', 'manage-link')
          and "mail_outbox"."subscriber_id" is not null
          and "mail_outbox"."class_key" is null
          and "mail_outbox"."opened_at" is null
          and "mail_outbox"."reason" is null
          and "mail_outbox"."expires_at" is null
        ) or (
          "mail_outbox"."kind" = 'operator'
          and "mail_outbox"."subscriber_id" is null
          and "mail_outbox"."opened_at" is null
          and "mail_outbox"."reason" is null
          and "mail_outbox"."expires_at" is null
        )),
	CONSTRAINT "mail_outbox_reason_valid" CHECK ("mail_outbox"."reason" is null or "mail_outbox"."reason" in ('seats-open', 'waitlist-open')),
	CONSTRAINT "mail_outbox_attempts_nonnegative" CHECK ("mail_outbox"."attempts" >= 0),
	CONSTRAINT "mail_outbox_claim_consistent" CHECK ((
          "mail_outbox"."status" = 'queued'
          and "mail_outbox"."claimed_at" is null
          and "mail_outbox"."claim_token" is null
          and "mail_outbox"."sent_at" is null
          and "mail_outbox"."terminal_at" is null
          and "mail_outbox"."terminal_reason" is null
        ) or (
          "mail_outbox"."status" = 'processing'
          and "mail_outbox"."claimed_at" is not null
          and "mail_outbox"."claim_token" is not null
          and "mail_outbox"."sent_at" is null
          and "mail_outbox"."terminal_at" is null
          and "mail_outbox"."terminal_reason" is null
        ) or (
          "mail_outbox"."status" = 'sent'
          and "mail_outbox"."claimed_at" is null
          and "mail_outbox"."claim_token" is null
          and "mail_outbox"."sent_at" is not null
          and "mail_outbox"."terminal_at" is not null
          and "mail_outbox"."terminal_reason" is null
          and "mail_outbox"."provider_accepted_at" is not null
        ) or (
          "mail_outbox"."status" in ('cancelled', 'dead_letter')
          and "mail_outbox"."claimed_at" is null
          and "mail_outbox"."claim_token" is null
          and "mail_outbox"."sent_at" is null
          and "mail_outbox"."terminal_at" is not null
          and "mail_outbox"."terminal_reason" is not null
        )),
	CONSTRAINT "mail_outbox_provider_key_bounded" CHECK (char_length("mail_outbox"."provider_idempotency_key") between 1 and 256),
	CONSTRAINT "mail_outbox_provider_metadata_bounded" CHECK (("mail_outbox"."provider_message_id" is null or char_length("mail_outbox"."provider_message_id") <= 512)
        and ("mail_outbox"."last_error_code" is null or char_length("mail_outbox"."last_error_code") <= 128)),
	CONSTRAINT "mail_outbox_payload_bounded" CHECK (jsonb_typeof("mail_outbox"."payload") = 'object' and pg_column_size("mail_outbox"."payload") <= 8192),
	CONSTRAINT "mail_outbox_updated_after_creation" CHECK ("mail_outbox"."updated_at" >= "mail_outbox"."created_at")
);
--> statement-breakpoint
ALTER TABLE "watches" DROP CONSTRAINT "watches_live_class_key_valid";--> statement-breakpoint
DROP INDEX "alert_deliveries_pending_idx";--> statement-breakpoint
ALTER TABLE "class_state" ALTER COLUMN "updated_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "terminal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "provider_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "provider_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "class_state" ADD COLUMN "source_fresh_until" timestamp with time zone DEFAULT clock_timestamp() + interval '120 seconds' NOT NULL;--> statement-breakpoint

-- v0.4 intentionally has no legacy production subscribers to grandfather.
-- Remove rows that cannot satisfy the newly bound public eligibility policy;
-- dependent watches/delivery rows cascade through their subscriber FK.
DELETE FROM "subscribers"
WHERE NOT (
  "email" = lower(btrim("email"))
  AND char_length("email") <= 254
  AND "email" ~ '^[^[:space:]@]+@berkeley[.]edu$'
  AND ("confirmed_at" IS NULL OR "confirmed_at" >= "created_at")
);--> statement-breakpoint

-- The previous migration deliberately retained malformed retired keys for
-- audit. v0.4 has no production data to preserve and binds every class_key
-- column, so remove those unusable remnants before adding strict checks.
DELETE FROM "alert_deliveries"
WHERE NOT (
  "class_key" ~ '^[0-9]{4}-(fall|spring|summer)-[a-z0-9]{1,32}-[a-z0-9]{1,32}-((?=[a-z0-9]{1,8}-)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})-[a-z]{2,8}-((?=[a-z0-9]{1,8}$)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})$'
  AND "reason" IN ('seats-open', 'waitlist-open')
);--> statement-breakpoint
DELETE FROM "watches"
WHERE NOT (
  "class_key" ~ '^[0-9]{4}-(fall|spring|summer)-[a-z0-9]{1,32}-[a-z0-9]{1,32}-((?=[a-z0-9]{1,8}-)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})-[a-z]{2,8}-((?=[a-z0-9]{1,8}$)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})$'
);--> statement-breakpoint
DELETE FROM "class_state"
WHERE NOT (
  "class_key" ~ '^[0-9]{4}-(fall|spring|summer)-[a-z0-9]{1,32}-[a-z0-9]{1,32}-((?=[a-z0-9]{1,8}-)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})-[a-z]{2,8}-((?=[a-z0-9]{1,8}$)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})$'
  AND "last_status" IN ('open', 'waitlist', 'closed')
);--> statement-breakpoint

DELETE FROM "suppressions"
WHERE NOT (
  "email" = lower(btrim("email"))
  AND char_length("email") <= 254
  AND "email" ~ '^[^[:space:]@]+@[^[:space:]@]+$'
  AND "reason" IN ('bounce', 'complaint')
);--> statement-breakpoint
DELETE FROM "push_subscriptions"
WHERE NOT (
  char_length("endpoint") <= 2048
  AND "endpoint" ~ '^https://[^[:space:]]+$'
  AND char_length("p256dh") BETWEEN 1 AND 512
  AND char_length("auth") BETWEEN 1 AND 512
);--> statement-breakpoint

UPDATE "class_state"
SET
  "last_open_seats" = greatest("last_open_seats", 0),
  "state_version" = greatest("state_version", 0),
  "observed_watch_order" = greatest("observed_watch_order", 1),
  -- Force a safe rebaseline after upgrading from a cache-unaware release.
  "source_fresh_until" = "updated_at";--> statement-breakpoint

UPDATE "watches"
SET "activation_order" = greatest("activation_order", 1);--> statement-breakpoint

UPDATE "alert_deliveries"
SET
  "watch_activation_order" = greatest("watch_activation_order", 1),
  "open_seats" = greatest("open_seats", 0),
  "attempt_count" = greatest("attempt_count", 0),
  "expires_at" = "opened_at" + interval '1 hour',
  "provider_idempotency_key" =
    'seat-sniper/alert/legacy/' ||
    md5("subscriber_id" || ':' || "class_key" || ':' || "opened_at"::text),
  "terminal_at" = coalesce("sent_at", "cancelled_at"),
  "provider_accepted_at" = "sent_at";--> statement-breakpoint

-- Transfer ownership of every still-pending legacy Alert to the unified
-- outbox before disabling the compatibility worker's copy. The legacy
-- provider key is retained so retries remain idempotent across the upgrade.
-- Already-expired Alerts are inserted terminal rather than made claimable.
WITH legacy_pending AS (
  SELECT
    ad.*,
    EXISTS (
      SELECT 1
      FROM "watches" AS w
      INNER JOIN "subscribers" AS s
        ON s."id" = w."subscriber_id"
      WHERE w."subscriber_id" = ad."subscriber_id"
        AND w."class_key" = ad."class_key"
        AND w."retired_at" IS NULL
        AND w."activation_order" = ad."watch_activation_order"
        AND s."confirmed_at" IS NOT NULL
    ) AS eligible
  FROM "alert_deliveries" AS ad
  WHERE ad."sent_at" IS NULL
    AND ad."cancelled_at" IS NULL
    AND ad."dead_lettered_at" IS NULL
)
INSERT INTO "mail_outbox" (
  "id",
  "kind",
  "subscriber_id",
  "class_key",
  "opened_at",
  "reason",
  "status",
  "attempts",
  "available_at",
  "expires_at",
  "terminal_at",
  "terminal_reason",
  "provider_idempotency_key",
  "payload",
  "created_at",
  "updated_at"
)
SELECT
  'legacy-alert-' || md5(lp."provider_idempotency_key"),
  'alert',
  lp."subscriber_id",
  lp."class_key",
  lp."opened_at",
  lp."reason",
  CASE
    WHEN lp."expires_at" <= statement_timestamp() OR NOT lp.eligible THEN 'cancelled'
    ELSE 'queued'
  END,
  lp."attempt_count",
  lp."next_attempt_at",
  lp."expires_at",
  CASE
    WHEN lp."expires_at" <= statement_timestamp() OR NOT lp.eligible
      THEN statement_timestamp()
    ELSE NULL
  END,
  CASE
    WHEN lp."expires_at" <= statement_timestamp() THEN 'expired'
    WHEN NOT lp.eligible THEN 'subscriber-ineligible'
    ELSE NULL
  END,
  lp."provider_idempotency_key",
  jsonb_build_object('openSeats', lp."open_seats"),
  lp."created_at",
  greatest(lp."created_at", statement_timestamp())
FROM legacy_pending AS lp;--> statement-breakpoint

-- A terminal compatibility row cannot be picked up by the old drain loop and
-- is eligible for the normal 90-day legacy retention sweep. Only rows proven
-- present in mail_outbox are terminalized.
UPDATE "alert_deliveries" AS ad
SET
  "dead_lettered_at" = clock_timestamp(),
  "terminal_at" = clock_timestamp()
WHERE ad."sent_at" IS NULL
  AND ad."cancelled_at" IS NULL
  AND ad."dead_lettered_at" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "mail_outbox" AS mo
    WHERE mo."provider_idempotency_key" = ad."provider_idempotency_key"
  );--> statement-breakpoint

ALTER TABLE "alert_deliveries" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ALTER COLUMN "provider_idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_outbox_alert_logical_uq" ON "mail_outbox" USING btree ("subscriber_id","class_key","opened_at") WHERE "mail_outbox"."kind" = 'alert';--> statement-breakpoint
CREATE INDEX "mail_outbox_claimable_idx" ON "mail_outbox" USING btree ("available_at","created_at") WHERE "mail_outbox"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "mail_outbox_processing_lease_idx" ON "mail_outbox" USING btree ("claimed_at") WHERE "mail_outbox"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "mail_outbox_subscriber_idx" ON "mail_outbox" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "mail_outbox_class_idx" ON "mail_outbox" USING btree ("class_key");--> statement-breakpoint
CREATE INDEX "mail_outbox_terminal_idx" ON "mail_outbox" USING btree ("terminal_at") WHERE "mail_outbox"."terminal_at" is not null;--> statement-breakpoint
CREATE INDEX "alert_deliveries_pending_idx" ON "alert_deliveries" USING btree ("next_attempt_at","created_at") WHERE "alert_deliveries"."sent_at" is null and "alert_deliveries"."cancelled_at" is null and "alert_deliveries"."dead_lettered_at" is null;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_provider_idempotency_uq" UNIQUE("provider_idempotency_key");--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_class_key_valid" CHECK ("alert_deliveries"."class_key" ~ '^[0-9]{4}-(fall|spring|summer)-[a-z0-9]{1,32}-[a-z0-9]{1,32}-((?=[a-z0-9]{1,8}-)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})-[a-z]{2,8}-((?=[a-z0-9]{1,8}$)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})$');--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_reason_valid" CHECK ("alert_deliveries"."reason" in ('seats-open', 'waitlist-open'));--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_attempt_count_nonnegative" CHECK ("alert_deliveries"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_watch_order_positive" CHECK ("alert_deliveries"."watch_activation_order" > 0);--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_one_hour_expiry" CHECK ("alert_deliveries"."expires_at" = "alert_deliveries"."opened_at" + interval '1 hour');--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_terminal_consistent" CHECK (num_nonnulls("alert_deliveries"."sent_at", "alert_deliveries"."cancelled_at", "alert_deliveries"."dead_lettered_at") <= 1
        and (
          ("alert_deliveries"."terminal_at" is null and num_nonnulls("alert_deliveries"."sent_at", "alert_deliveries"."cancelled_at", "alert_deliveries"."dead_lettered_at") = 0)
          or
          ("alert_deliveries"."terminal_at" is not null and num_nonnulls("alert_deliveries"."sent_at", "alert_deliveries"."cancelled_at", "alert_deliveries"."dead_lettered_at") = 1)
        ));--> statement-breakpoint
ALTER TABLE "class_state" ADD CONSTRAINT "class_state_class_key_valid" CHECK ("class_state"."class_key" ~ '^[0-9]{4}-(fall|spring|summer)-[a-z0-9]{1,32}-[a-z0-9]{1,32}-((?=[a-z0-9]{1,8}-)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})-[a-z]{2,8}-((?=[a-z0-9]{1,8}$)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})$');--> statement-breakpoint
ALTER TABLE "class_state" ADD CONSTRAINT "class_state_status_valid" CHECK ("class_state"."last_status" in ('open', 'waitlist', 'closed'));--> statement-breakpoint
ALTER TABLE "class_state" ADD CONSTRAINT "class_state_open_seats_nonnegative" CHECK ("class_state"."last_open_seats" >= 0);--> statement-breakpoint
ALTER TABLE "class_state" ADD CONSTRAINT "class_state_version_nonnegative" CHECK ("class_state"."state_version" >= 0);--> statement-breakpoint
ALTER TABLE "class_state" ADD CONSTRAINT "class_state_observed_order_positive" CHECK ("class_state"."observed_watch_order" > 0);--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_https_endpoint" CHECK (char_length("push_subscriptions"."endpoint") <= 2048 and "push_subscriptions"."endpoint" ~ '^https://[^[:space:]]+$');--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_keys_bounded" CHECK (char_length("push_subscriptions"."p256dh") between 1 and 512 and char_length("push_subscriptions"."auth") between 1 and 512);--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_email_normalized_berkeley" CHECK ("subscribers"."email" = lower(btrim("subscribers"."email"))
        and char_length("subscribers"."email") <= 254
        and "subscribers"."email" ~ '^[^[:space:]@]+@berkeley[.]edu$');--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_confirmation_after_creation" CHECK ("subscribers"."confirmed_at" is null or "subscribers"."confirmed_at" >= "subscribers"."created_at");--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_email_normalized" CHECK ("suppressions"."email" = lower(btrim("suppressions"."email"))
        and char_length("suppressions"."email") <= 254
        and "suppressions"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+$');--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_reason_valid" CHECK ("suppressions"."reason" in ('bounce', 'complaint'));--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_class_key_valid" CHECK ("watches"."class_key" ~ '^[0-9]{4}-(fall|spring|summer)-[a-z0-9]{1,32}-[a-z0-9]{1,32}-((?=[a-z0-9]{1,8}-)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})-[a-z]{2,8}-((?=[a-z0-9]{1,8}$)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})$');--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_activation_order_positive" CHECK ("watches"."activation_order" > 0);
