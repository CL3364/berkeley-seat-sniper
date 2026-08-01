CREATE TABLE "alert_deliveries" (
	"subscriber_id" text NOT NULL,
	"class_key" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"open_seats" integer NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_deliveries_subscriber_class_opened_pk" PRIMARY KEY("subscriber_id","class_key","opened_at"),
	CONSTRAINT "alert_deliveries_open_seats_nonnegative" CHECK ("alert_deliveries"."open_seats" >= 0)
);
--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_deliveries_pending_idx" ON "alert_deliveries" USING btree ("created_at") WHERE "alert_deliveries"."sent_at" is null;