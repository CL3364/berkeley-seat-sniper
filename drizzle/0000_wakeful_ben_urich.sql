CREATE TABLE IF NOT EXISTS "class_state" (
	"class_key" text PRIMARY KEY NOT NULL,
	"last_status" text NOT NULL,
	"last_open_seats" integer NOT NULL,
	"last_waitlist_open" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscribers" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscribers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watches" (
	"id" text PRIMARY KEY NOT NULL,
	"subscriber_id" text NOT NULL,
	"class_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watches_subscriber_class_uq" UNIQUE("subscriber_id","class_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "watches" ADD CONSTRAINT "watches_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watches_class_key_idx" ON "watches" USING btree ("class_key");