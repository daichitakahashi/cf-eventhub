import { relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { EventPayload } from "../core";
import type { DispatchExecution, ResultedDispatch } from "../core/model";

const eventhub = pgSchema("eventhub");

export const events = eventhub.table(
  "events",
  {
    /**
     * Event ID
     */
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Payload of the event
     */
    payload: jsonb("payload").notNull().$type<EventPayload>(),

    /**
     * Create time
     */
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (t) => ({
    createdAtIndex: index().on(t.createdAt),
  }),
);

export const eventsRelations = relations(events, ({ many }) => ({
  dispatches: many(dispatches),
}));

export const dispatches = eventhub.table("dispatches", {
  /**
   * Dispatch ID
   */
  id: uuid("id").primaryKey().defaultRandom(),

  /**
   * Event ID
   */
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id),

  /**
   * Dispatch destination
   */
  destination: text("destination").notNull(),

  /**
   * Create time
   */
  createdAt: timestamp("created_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),

  /**
   * First delay seconds
   */
  delaySeconds: integer("delay_seconds"),

  /**
   * Max retry count
   */
  maxRetries: integer("max_retries").notNull(),
});

export const dispatchesRelations = relations(dispatches, ({ one, many }) => ({
  event: one(events, {
    fields: [dispatches.eventId],
    references: [events.id],
  }),
  executions: many(dispatchExecutions),
  result: one(dispatchResults),
}));

export const dispatchExecutions = eventhub.table("dispatch_executions", {
  /**
   * Execution ID
   */
  id: uuid("id").primaryKey().defaultRandom(),

  /**
   * Dispatch ID
   */
  dispatchId: uuid("dispatch_id")
    .notNull()
    .references(() => dispatches.id),

  /**
   * Result of the execution
   */
  result: text("result").notNull().$type<DispatchExecution["result"]>(),

  /**
   * Execute time
   */
  executedAt: timestamp("executed_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
});

export const dispatchExecutionsRelations = relations(
  dispatchExecutions,
  ({ one }) => ({
    dispatch: one(dispatches, {
      fields: [dispatchExecutions.dispatchId],
      references: [dispatches.id],
    }),
  }),
);

export const dispatchResults = eventhub.table("dispatch_results", {
  /**
   * Dispatch ID
   */
  dispatchId: uuid("dispatch_id")
    .primaryKey()
    .references(() => dispatches.id),

  /**
   * Result of the dispatch
   */
  result: text("result").notNull().$type<ResultedDispatch["status"]>(),

  /**
   * Resulted time
   */
  resultedAt: timestamp("resulted_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
});

export const dispatchResultsRelations = relations(
  dispatchResults,
  ({ one }) => ({
    dispatch: one(dispatches, {
      fields: [dispatchResults.dispatchId],
      references: [dispatches.id],
    }),
  }),
);
