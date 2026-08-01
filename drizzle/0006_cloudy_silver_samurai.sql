-- Preserve any pre-contract invalid row for audit/history, but keep it out of
-- the worker queue: strict repo paths cannot safely fetch or retire it.
UPDATE "watches"
SET "retired_at" = clock_timestamp()
WHERE "retired_at" IS NULL
  AND NOT (
    "class_key" ~ '^[0-9]{4}-(fall|spring|summer)-[a-z0-9]{1,32}-[a-z0-9]{1,32}-[0-9]{3}-(lec|dis|lab|sem|fld|ind|stu|wbn)-[0-9]{3}$'
  );
--> statement-breakpoint
-- An old pending row would otherwise throw at strict key validation before the
-- retired-watch eligibility check can cancel it. Sent history remains intact.
UPDATE "alert_deliveries"
SET "cancelled_at" = clock_timestamp()
WHERE "sent_at" IS NULL
  AND "cancelled_at" IS NULL
  AND NOT (
    "class_key" ~ '^[0-9]{4}-(fall|spring|summer)-[a-z0-9]{1,32}-[a-z0-9]{1,32}-[0-9]{3}-(lec|dis|lab|sem|fld|ind|stu|wbn)-[0-9]{3}$'
  );
--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_live_class_key_length" CHECK ("watches"."retired_at" is not null or char_length("watches"."class_key") <= 89);
