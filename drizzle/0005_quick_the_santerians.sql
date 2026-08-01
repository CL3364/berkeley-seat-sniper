DROP INDEX "alert_deliveries_pending_idx";--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "alert_deliveries_pending_idx" ON "alert_deliveries" USING btree ("next_attempt_at","created_at") WHERE "alert_deliveries"."sent_at" is null and "alert_deliveries"."cancelled_at" is null;