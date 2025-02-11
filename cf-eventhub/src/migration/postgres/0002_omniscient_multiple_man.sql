UPDATE "eventhub"."dispatches" SET "delay_seconds" = 0 WHERE "delay_seconds" IS NULL;--> statement-breakpoint
ALTER TABLE "eventhub"."dispatches" ALTER COLUMN "delay_seconds" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "eventhub"."dispatches" ADD COLUMN "retry_delay" jsonb NOT NULL;