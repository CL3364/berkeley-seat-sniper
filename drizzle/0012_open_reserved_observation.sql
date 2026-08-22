ALTER TABLE "class_state" ADD COLUMN "last_open_reserved" integer;--> statement-breakpoint
ALTER TABLE "class_state" ADD CONSTRAINT "class_state_open_reserved_subset" CHECK ("class_state"."last_open_reserved" is null
        or ("class_state"."last_open_reserved" >= 0 and "class_state"."last_open_reserved" <= "class_state"."last_open_seats"));--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "open_reserved" integer;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_open_reserved_subset" CHECK ("alert_deliveries"."open_reserved" is null
        or ("alert_deliveries"."open_reserved" >= 0 and "alert_deliveries"."open_reserved" <= "alert_deliveries"."open_seats"));
