CREATE INDEX IF NOT EXISTS "dispatch_executions_executed_at_index" ON "eventhub"."dispatch_executions" USING btree ("executed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispatch_results_resulted_at_index" ON "eventhub"."dispatch_results" USING btree ("resulted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispatches_created_at_index" ON "eventhub"."dispatches" USING btree ("created_at");