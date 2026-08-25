ALTER TABLE "mail_outbox" DROP CONSTRAINT "mail_outbox_kind_valid";--> statement-breakpoint
ALTER TABLE "mail_outbox" DROP CONSTRAINT "mail_outbox_shape_valid";--> statement-breakpoint
CREATE UNIQUE INDEX "mail_outbox_blind_window_logical_uq" ON "mail_outbox" USING btree ("subscriber_id","class_key","opened_at") WHERE "mail_outbox"."kind" = 'blind-window';--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_kind_valid" CHECK ("mail_outbox"."kind" in ('alert', 'confirmation', 'manage-link', 'operator', 'blind-window'));--> statement-breakpoint
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
        ) or (
          "mail_outbox"."kind" = 'blind-window'
          and ("mail_outbox"."subscriber_id" is not null or "mail_outbox"."status" = 'dead_letter')
          and "mail_outbox"."class_key" is not null
          and "mail_outbox"."opened_at" is not null
          and "mail_outbox"."reason" is null
          and "mail_outbox"."expires_at" is null
        ));