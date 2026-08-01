CREATE TABLE "dead_letter_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_job_id" text NOT NULL,
	"state" text DEFAULT 'unresolved' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"surfaced_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "dead_letter_incidents_mail_job_id_unique" UNIQUE("mail_job_id"),
	CONSTRAINT "dead_letter_incidents_state_valid" CHECK ("dead_letter_incidents"."state" in ('unresolved', 'acknowledged', 'resolved')),
	CONSTRAINT "dead_letter_incidents_state_consistent" CHECK ((
          "dead_letter_incidents"."state" = 'unresolved'
          and "dead_letter_incidents"."acknowledged_at" is null
          and "dead_letter_incidents"."resolved_at" is null
        ) or (
          "dead_letter_incidents"."state" = 'acknowledged'
          and "dead_letter_incidents"."acknowledged_at" is not null
          and "dead_letter_incidents"."resolved_at" is null
        ) or (
          "dead_letter_incidents"."state" = 'resolved'
          and "dead_letter_incidents"."resolved_at" is not null
        )),
	CONSTRAINT "dead_letter_incidents_timestamps_ordered" CHECK (("dead_letter_incidents"."surfaced_at" is null or "dead_letter_incidents"."surfaced_at" >= "dead_letter_incidents"."opened_at")
        and ("dead_letter_incidents"."acknowledged_at" is null or "dead_letter_incidents"."acknowledged_at" >= "dead_letter_incidents"."opened_at")
        and ("dead_letter_incidents"."resolved_at" is null or "dead_letter_incidents"."resolved_at" >= "dead_letter_incidents"."opened_at")
        and (
          "dead_letter_incidents"."acknowledged_at" is null
          or "dead_letter_incidents"."resolved_at" is null
          or "dead_letter_incidents"."resolved_at" >= "dead_letter_incidents"."acknowledged_at"
        ))
);
--> statement-breakpoint
CREATE TABLE "parser_health" (
	"class_key" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"episode_started_at" timestamp with time zone,
	"alert_enqueued_at" timestamp with time zone,
	"recovered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "parser_health_class_key_valid" CHECK ("parser_health"."class_key" ~ '^[0-9]{4}-(fall|spring|summer)-[a-z0-9]{1,32}-[a-z0-9]{1,32}-((?=[a-z0-9]{1,8}-)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})-[a-z]{2,8}-((?=[a-z0-9]{1,8}$)(?=[a-z0-9]*[a-z])[a-z0-9]+|[0-9]{3,8})$'),
	CONSTRAINT "parser_health_status_valid" CHECK ("parser_health"."status" in ('healthy', 'broken')),
	CONSTRAINT "parser_health_state_consistent" CHECK ((
          "parser_health"."status" = 'broken'
          and "parser_health"."episode_started_at" is not null
          and "parser_health"."alert_enqueued_at" is not null
          and "parser_health"."recovered_at" is null
          and "parser_health"."alert_enqueued_at" >= "parser_health"."episode_started_at"
          and "parser_health"."updated_at" >= "parser_health"."alert_enqueued_at"
        ) or (
          "parser_health"."status" = 'healthy'
          and "parser_health"."episode_started_at" is not null
          and "parser_health"."alert_enqueued_at" is not null
          and "parser_health"."recovered_at" is not null
          and "parser_health"."alert_enqueued_at" >= "parser_health"."episode_started_at"
          and "parser_health"."recovered_at" >= "parser_health"."alert_enqueued_at"
          and "parser_health"."updated_at" >= "parser_health"."recovered_at"
        ))
);
--> statement-breakpoint
ALTER TABLE "mail_outbox" DROP CONSTRAINT "mail_outbox_shape_valid";--> statement-breakpoint
ALTER TABLE "subscribers" DROP CONSTRAINT "subscribers_email_normalized_berkeley";--> statement-breakpoint
ALTER TABLE "watches" DROP CONSTRAINT "watches_activation_order_positive";--> statement-breakpoint
ALTER TABLE "watches" ALTER COLUMN "activated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "watches" ALTER COLUMN "activated_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "watches" ALTER COLUMN "activation_order" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "watches" ALTER COLUMN "activation_order" DROP NOT NULL;--> statement-breakpoint

-- v0.4.2 launches before production data exists. Remove pre-contract plus-tag
-- aliases before tightening the base-address-only subscriber constraint;
-- dependent staged watches and mail cascade with the Subscriber.
DELETE FROM "subscribers"
WHERE NOT (
  "email" = lower(btrim("email"))
  AND char_length("email") <= 254
  AND "email" ~ '^[^+[:space:]@]+@berkeley[.]edu$'
);--> statement-breakpoint

-- Pending Watches become true staged demand. Existing Confirmed Watches retain
-- their activation boundary; every existing Pending Watch releases its former
-- source-capacity reservation.
UPDATE "watches" AS w
SET
  "activated_at" = NULL,
  "activation_order" = NULL
FROM "subscribers" AS s
WHERE s."id" = w."subscriber_id"
  AND s."confirmed_at" IS NULL;--> statement-breakpoint

ALTER TABLE "dead_letter_incidents" ADD CONSTRAINT "dead_letter_incidents_mail_job_id_mail_outbox_id_fk" FOREIGN KEY ("mail_job_id") REFERENCES "public"."mail_outbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Every v0.4.1 terminal failure was operator-unresolved because the former
-- schema had no durable acknowledgement lifecycle.
INSERT INTO "dead_letter_incidents" (
  "id",
  "mail_job_id",
  "state",
  "opened_at"
)
SELECT
  substring(md5("id"), 1, 8)
    || '-' || substring(md5("id"), 9, 4)
    || '-3' || substring(md5("id"), 14, 3)
    || '-8' || substring(md5("id"), 18, 3)
    || '-' || substring(md5("id"), 21, 12),
  "id",
  'unresolved',
  "terminal_at"
FROM "mail_outbox"
WHERE "status" = 'dead_letter'
ON CONFLICT ("mail_job_id") DO NOTHING;--> statement-breakpoint

CREATE INDEX "dead_letter_incidents_unresolved_idx" ON "dead_letter_incidents" USING btree ("opened_at") WHERE "dead_letter_incidents"."state" = 'unresolved';--> statement-breakpoint
CREATE INDEX "dead_letter_incidents_unsurfaced_idx" ON "dead_letter_incidents" USING btree ("opened_at") WHERE "dead_letter_incidents"."surfaced_at" is null;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_shape_valid" CHECK ((
          "mail_outbox"."kind" = 'alert'
          and ("mail_outbox"."subscriber_id" is not null or "mail_outbox"."status" = 'dead_letter')
          and "mail_outbox"."class_key" is not null
          and "mail_outbox"."opened_at" is not null
          and "mail_outbox"."reason" is not null
          and "mail_outbox"."expires_at" = "mail_outbox"."opened_at" + interval '1 hour'
        ) or (
          "mail_outbox"."kind" in ('confirmation', 'manage-link')
          and ("mail_outbox"."subscriber_id" is not null or "mail_outbox"."status" = 'dead_letter')
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
        ));--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_email_normalized_berkeley" CHECK ("subscribers"."email" = lower(btrim("subscribers"."email"))
        and char_length("subscribers"."email") <= 254
        and "subscribers"."email" ~ '^[^+[:space:]@]+@berkeley[.]edu$');--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_activation_consistent" CHECK (("watches"."activated_at" is null and "watches"."activation_order" is null)
        or ("watches"."activated_at" is not null and "watches"."activation_order" > 0));
