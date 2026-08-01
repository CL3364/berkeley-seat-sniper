ALTER TABLE "class_state" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "class_state" ADD COLUMN "last_enrolled" integer;--> statement-breakpoint
ALTER TABLE "class_state" ADD COLUMN "last_capacity" integer;--> statement-breakpoint
ALTER TABLE "class_state" ADD COLUMN "last_waitlisted" integer;--> statement-breakpoint
ALTER TABLE "class_state" ADD COLUMN "last_waitlist_max" integer;--> statement-breakpoint
ALTER TABLE "class_state" ADD CONSTRAINT "class_state_display_name_valid" CHECK ("class_state"."display_name" is null or char_length("class_state"."display_name") between 1 and 256);--> statement-breakpoint
ALTER TABLE "class_state" ADD CONSTRAINT "class_state_enrolled_nonnegative" CHECK ("class_state"."last_enrolled" is null or "class_state"."last_enrolled" >= 0);--> statement-breakpoint
ALTER TABLE "class_state" ADD CONSTRAINT "class_state_capacity_nonnegative" CHECK ("class_state"."last_capacity" is null or "class_state"."last_capacity" >= 0);--> statement-breakpoint
ALTER TABLE "class_state" ADD CONSTRAINT "class_state_waitlisted_nonnegative" CHECK ("class_state"."last_waitlisted" is null or "class_state"."last_waitlisted" >= 0);--> statement-breakpoint
ALTER TABLE "class_state" ADD CONSTRAINT "class_state_waitlist_max_nonnegative" CHECK ("class_state"."last_waitlist_max" is null or "class_state"."last_waitlist_max" >= 0);