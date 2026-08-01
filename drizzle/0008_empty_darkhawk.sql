CREATE SEQUENCE "public"."watch_visibility_order_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "watch_activation_order" bigint;--> statement-breakpoint
ALTER TABLE "class_state" ADD COLUMN "observed_watch_order" bigint;--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "activation_order" bigint;--> statement-breakpoint

-- Preserve the timestamp-era visibility relation at the migration boundary.
-- Generation 1 means the watch was visible to the existing class baseline;
-- generation 2 means it still needs a successful post-activation observation.
UPDATE "class_state"
SET "observed_watch_order" = 1;--> statement-breakpoint
UPDATE "watches" AS w
SET "activation_order" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM "class_state" AS cs
    WHERE cs."class_key" = w."class_key"
      AND w."activated_at" <= cs."updated_at"
  ) THEN 1
  ELSE 2
END;--> statement-breakpoint

-- Bind pre-migration pending deliveries to the exact watch incarnation that
-- originally qualified. Sentinel 0 makes missing/re-added watches ineligible.
UPDATE "alert_deliveries" AS ad
SET "watch_activation_order" = COALESCE((
  SELECT w."activation_order"
  FROM "watches" AS w
  WHERE w."subscriber_id" = ad."subscriber_id"
    AND w."class_key" = ad."class_key"
    AND w."activated_at" <= ad."created_at"
  LIMIT 1
), 0);--> statement-breakpoint

ALTER TABLE "class_state" ALTER COLUMN "observed_watch_order" SET DEFAULT nextval('watch_visibility_order_seq');--> statement-breakpoint
ALTER TABLE "class_state" ALTER COLUMN "observed_watch_order" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "watches" ALTER COLUMN "activation_order" SET DEFAULT nextval('watch_visibility_order_seq');--> statement-breakpoint
ALTER TABLE "watches" ALTER COLUMN "activation_order" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ALTER COLUMN "watch_activation_order" SET NOT NULL;--> statement-breakpoint

-- The first runtime allocation is 3; sequence gaps are harmless and monotonic.
SELECT setval('watch_visibility_order_seq', 2, true);
