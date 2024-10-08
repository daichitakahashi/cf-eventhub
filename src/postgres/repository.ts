import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type {
  PostgresJsDatabase,
  PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";
import { type Result, err, fromAsyncThrowable } from "neverthrow";

import type { Logger } from "../core/logger";
import {
  type CreatedEvent,
  type Dispatch,
  type NewDispatch,
  type NewEvent,
  type OngoingDispatch,
  appendExecutionLog,
  createdEvent,
  dispatchExecution,
  isNewDispatchExecution,
  isResultedDispatch,
  makeDispatchLost,
  ongoingDispatch,
} from "../core/model";
import type { Repository } from "../core/repository";
import * as schema from "./schema";

type Db = PostgresJsDatabase<typeof schema>;
type Tx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** @internal */
export class PgRepository implements Repository {
  constructor(
    private db: Db | Tx,
    private logger: Logger,
  ) {}

  async enterTransactionalScope<T, E>(
    fn: (tx: Repository) => Promise<Result<T, E>>,
  ): Promise<Result<T, "INTERNAL_SERVER_ERROR" | E>> {
    let result: Result<T, E>;

    try {
      await this.db.transaction(async (tx) => {
        result = await fn(new PgRepository(tx, this.logger));
        if (result.isOk()) return;
        tx.rollback();
      });
    } catch {}

    // @ts-ignore
    if (!result) {
      return err("INTERNAL_SERVER_ERROR" as const);
    }
    return result;
  }

  async createEvents(
    events: Omit<NewEvent, "id">[],
  ): Promise<Result<CreatedEvent[], "INTERNAL_SERVER_ERROR">> {
    const db = this.db;
    return fromAsyncThrowable(
      async () => {
        const values = events.map((e): typeof schema.events.$inferInsert => ({
          payload: e.payload,
          createdAt: e.createdAt,
        }));

        const inserted = await db
          .insert(schema.events)
          .values(values)
          .returning();
        return inserted.map((r) =>
          createdEvent(r.id, {
            payload: r.payload,
            createdAt: r.createdAt,
          }),
        );
      },
      (e) => {
        this.logger.error("error on createEvents:", e);
        return "INTERNAL_SERVER_ERROR" as const;
      },
    )();
  }

  async createDispatches(
    dispatches: NewDispatch[],
  ): Promise<Result<OngoingDispatch[], "INTERNAL_SERVER_ERROR">> {
    const db = this.db;
    return fromAsyncThrowable(
      async () => {
        const values = dispatches.map(
          (d): typeof schema.dispatches.$inferInsert => ({
            eventId: d.eventId,
            destination: d.destination,
            createdAt: d.createdAt,
            delaySeconds: d.delaySeconds,
            maxRetries: d.maxRetries,
          }),
        );

        const inserted = await db
          .insert(schema.dispatches)
          .values(values)
          .returning();
        return inserted.map((r) =>
          ongoingDispatch(r.id, {
            eventId: r.eventId,
            destination: r.destination,
            createdAt: r.createdAt,
            delaySeconds: r.delaySeconds,
            maxRetries: r.maxRetries,
          }),
        );
      },
      (e) => {
        this.logger.error("error on createDispatches:", e);
        return "INTERNAL_SERVER_ERROR" as const;
      },
    )();
  }

  async saveDispatch(
    dispatch: Dispatch,
  ): Promise<Result<void, "INTERNAL_SERVER_ERROR">> {
    const db = this.db;
    return fromAsyncThrowable(
      async () => {
        const executions = dispatch.executionLog
          .filter(isNewDispatchExecution)
          .map((e): typeof schema.dispatchExecutions.$inferInsert => ({
            dispatchId: dispatch.id,
            result: e.result,
            executedAt: e.executedAt,
          }));
        if (executions.length > 0) {
          await db.insert(schema.dispatchExecutions).values(executions);
        }

        if (isResultedDispatch(dispatch)) {
          await db.insert(schema.dispatchResults).values({
            dispatchId: dispatch.id,
            result: dispatch.status,
            resultedAt: dispatch.resultedAt,
          });
        }
      },
      (e) => {
        this.logger.error("error on saveDispatch:", e);
        return "INTERNAL_SERVER_ERROR" as const;
      },
    )();
  }

  async getDispatch(
    dispatchId: string,
  ): Promise<
    Result<
      { event: CreatedEvent; dispatch: Dispatch } | null,
      "INTERNAL_SERVER_ERROR"
    >
  > {
    const db = this.db;
    return fromAsyncThrowable(
      async () => {
        const row = await db.query.dispatches.findFirst({
          with: {
            event: true,
            executions: true,
            result: true,
          },
          where: (dispatches, { eq }) => eq(dispatches.id, dispatchId),
        });
        if (!row) {
          return null;
        }

        const event = createdEvent(row.event.id, {
          payload: row.event.payload,
          createdAt: row.event.createdAt,
        });

        let dispatch: Dispatch = ongoingDispatch(row.id, {
          eventId: row.eventId,
          destination: row.destination,
          createdAt: row.createdAt,
          delaySeconds: row.delaySeconds,
          maxRetries: row.maxRetries,
        });
        for (const e of row.executions) {
          if (dispatch.status === "ongoing") {
            dispatch = appendExecutionLog(
              dispatch,
              dispatchExecution(e.id, e.result, e.executedAt),
            );
          }
        }

        if (dispatch.status === "ongoing" && row.result?.result === "lost") {
          dispatch = makeDispatchLost(dispatch, row.result.resultedAt);
        }

        return { event, dispatch };
      },
      (e) => {
        this.logger.error("error on getDispatch:", e);
        return "INTERNAL_SERVER_ERROR" as const;
      },
    )();
  }
}
