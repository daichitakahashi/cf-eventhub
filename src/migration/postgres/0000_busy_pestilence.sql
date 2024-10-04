CREATE SCHEMA IF NOT EXISTS eventhub;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eventhub"."dispatch_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"result" text NOT NULL,
	"executed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eventhub"."dispatch_results" (
	"dispatch_id" uuid PRIMARY KEY NOT NULL,
	"result" text NOT NULL,
	"resulted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eventhub"."dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"delay_seconds" integer,
	"max_retries" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eventhub"."events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eventhub"."dispatch_executions" ADD CONSTRAINT "dispatch_executions_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "eventhub"."dispatches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eventhub"."dispatch_results" ADD CONSTRAINT "dispatch_results_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "eventhub"."dispatches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eventhub"."dispatches" ADD CONSTRAINT "dispatches_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "eventhub"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_created_at_index" ON "eventhub"."events" USING btree ("created_at");