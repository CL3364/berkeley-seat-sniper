DROP INDEX "alert_deliveries_pending_idx";--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "activated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "watches"
SET "activated_at" = GREATEST("watches"."created_at", COALESCE("subscribers"."confirmed_at", "watches"."created_at"))
FROM "subscribers"
WHERE "watches"."subscriber_id" = "subscribers"."id";--> statement-breakpoint
CREATE INDEX "alert_deliveries_pending_idx" ON "alert_deliveries" USING btree ("created_at") WHERE "alert_deliveries"."sent_at" is null and "alert_deliveries"."cancelled_at" is null;
