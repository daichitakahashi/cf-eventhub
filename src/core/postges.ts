import { eq, relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";

import type { Persistence } from "./model";

// FIXME: Retryはconsumerの設定がハードリミットになるので、ソフトリミットとして後で機能追加することとする。
// 実行回数ではなく実行記録を置いておく方法。
// delaySecondsを保持する。
// exponential backoffをどう設定してもらうか。

export const events = pgTable(
  "events",
  {
    /**
     * Event ID
     */
    id: uuid("id").primaryKey(),

    /**
     * Payload of the event
     */
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),

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
  ongoingDispatches: many(ongoingDispatches),
  resultedDispatches: many(resultedDispatches),
}));

export const ongoingDispatches = pgTable(
  "ongoing_dispatches",
  {
    /**
     * Dispatch ID
     */
    id: uuid("id").primaryKey(),

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
     * Current execution count
     */
    executionCount: integer("execution_count").notNull().default(0),

    /**
     * Max retry count
     */
    maxRetryCount: integer("max_retry_count").notNull(),
  },
  (t) => ({
    destinationIndex: index().on(t.destination),
    createdAtIndex: index().on(t.createdAt),
  }),
);

export const ongoingDispatchesRelations = relations(
  ongoingDispatches,
  ({ one }) => ({
    event: one(events, {
      fields: [ongoingDispatches.eventId],
      references: [events.id],
    }),
  }),
);

export const resultedDispatches = pgTable("resulted_dispatches", {
  /**
   * Dispatch ID
   */
  id: uuid("id").primaryKey(),

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
   * Result of dispatch
   */
  result: text("result", {
    enum: ["succeeded", "ignored", "failed", "lost"],
  }).notNull(),

  /**
   * Resulted time
   */
  resultedAt: timestamp("resulted_at").notNull(),

  /**
   * Current execution count
   */
  executionCount: integer("execution_count").notNull().default(0),

  /**
   * Max retry count
   */
  maxRetryCount: integer("max_retry_count").notNull(),
});

export const resultedDispatchesRelations = relations(
  resultedDispatches,
  ({ one }) => ({
    event: one(events, {
      fields: [resultedDispatches.eventId],
      references: [events.id],
    }),
  }),
);

export const createPersistence = (): Persistence => {
  const db = drizzle(null, {
    // FIXME:
    schema: {
      events,
      ongoingDispatches,
      resultedDispatches,
      eventsRelations,
      ongoingDispatchesRelations,
      resultedDispatchesRelations,
    },
  });

  return {
    async createEvent(event) {
      await db.insert(events).values({
        id: event.id,
        payload: event.payload,
        createdAt: event.createdAt,
      });
    },

    async createDispatches(eventId, dispatches) {
      await db.insert(ongoingDispatches).values(
        dispatches.map((d) => ({
          id: d.id,
          eventId,
          destination: d.destination,
          createdAt: d.createdAt,
          executionCount: 0,
          maxRetryCount: d.maxRetryCount,
        })),
      );
    },

    async getDispatch(dispatchId: string) {
      const cte = db
        .$with("d")
        .as((db) =>
          db
            .select()
            .from(ongoingDispatches)
            .innerJoin(events, eq(ongoingDispatches.eventId, events.id))
            .where(eq(ongoingDispatches.id, dispatchId))
            .limit(1),
        );
      const result = await db
        .with(cte)
        .update(ongoingDispatches)
        .set({
          executionCount: sql`execution_count + 1`,
        })
        .where(eq(ongoingDispatches.id, dispatchId))
        .returning({
          dispatch: cte.ongoing_dispatches,
          event: cte.events,
        });
      //
      //   db
      //     .update(ongoingDispatches)
      //     .set({
      //       executionCount: sql`execution_count + 1`,
      //     })
      //     .returning(),
      // );
    },

    async updateDispatchSucceeded(dispatchId: string) {},

    async updateDispatchIgnored(dispatchId: string) {},

    async updateDispatchFailed(dispatchId: string) {},

    async updateLostDispatches(dispatchIds: string[]) {},
  };
};
