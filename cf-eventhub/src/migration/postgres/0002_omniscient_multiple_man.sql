UPDATE "eventhub"."dispatches" SET "delay_seconds" = 0 WHERE "delay_seconds" IS NULL;--> statement-breakpoint
ALTER TABLE "eventhub"."dispatches" ALTER COLUMN "delay_seconds" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "eventhub"."dispatches" ADD COLUMN "retry_delay" JSONB;--> statement-breakpoint
UPDATE "eventhub"."dispatches" SET "retry_delay" = jsonb_build_object(
    'type', 'constant',
    'interval', delay_seconds
) WHERE "retry_delay" IS NULL;--> statement-breakpoint
ALTER TABLE "eventhub"."dispatches" ALTER COLUMN "retry_delay" SET NOT NULL;
