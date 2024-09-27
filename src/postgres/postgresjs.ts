import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import {
  type PostgresJsDatabase,
  type PostgresJsQueryResultHKT,
  drizzle,
} from "drizzle-orm/postgres-js";
import { type Result, err, fromAsyncThrowable } from "neverthrow";
import postgres from "postgres";

import { Executor as BaseExecutor } from "../core/executor";
import { EventHub as BaseEventHub } from "../core/hub";
import {
  type CreatedEvent,
  type Dispatch,
  type NewDispatch,
  type NewEvent,
  type OngoingDispatch,
  appendExecutionLog,
  createdEvent,
  isNewDispatchExecution,
  isResultedDispatch,
  ongoingDispatch,
} from "../core/model";
import type { Repository } from "../core/repository";
import * as schema from "./schema";

const createRepository = (env: Record<string, unknown>): Repository => {
  const dsn = env.EVENTHUB_DSN;
  if (typeof dsn !== "string") {
    throw new Error("cf-eventhub: EVENTHUB_DSN not set");
  }
  const pg = postgres(dsn);
  const db = drizzle(pg, { schema });
  return new PgRepository(db);
};

type Db = PostgresJsDatabase<typeof schema>;
type Tx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

class PgRepository implements Repository {
  constructor(private db: Db | Tx) {}

  async enterTransactionalScope<T, E>(
    fn: (tx: Repository) => Promise<Result<T, E>>,
  ): Promise<Result<T, "INTERNAL_SERVER_ERROR" | E>> {
    let result: Result<T, E>;

    await this.db.transaction(async (tx) => {
      result = await fn(new PgRepository(tx));
      if (result.isOk()) return;
      tx.rollback();
    });
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
        console.error(e); // TODO:
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
            maxRetryCount: d.maxRetryCount,
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
            maxRetryCount: r.maxRetryCount,
          }),
        );
      },
      (e) => {
        console.error(e); // TODO:
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
        console.error(e); // TODO:
        return "INTERNAL_SERVER_ERROR" as const;
      },
    )();
  }

  async getDispatch(
    dispatchId: string,
  ): Promise<
    Result<{ event: CreatedEvent; dispatch: Dispatch }, "INTERNAL_SERVER_ERROR">
  > {
    const db = this.db;
    return fromAsyncThrowable(
      async () => {
        const row = await db.query.dispatches.findFirst({
          with: {
            event: true,
            executions: true,
            // result: true,
          },
          where: (dispatches, { eq }) => eq(dispatches.id, dispatchId),
        });
        if (!row) {
          throw new Error("dispatch not found");
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
          maxRetryCount: row.maxRetryCount,
        });
        for (const e of row.executions) {
          if (dispatch.status === "ongoing") {
            dispatch = appendExecutionLog(dispatch, {
              result: e.result,
              executedAt: e.executedAt,
            });
          }
        }

        return { event, dispatch };
      },
      (e) => {
        console.error(e); // TODO:
        return "INTERNAL_SERVER_ERROR" as const;
      },
    )();
  }
}

export class Executor extends BaseExecutor {
  protected getRepository(env: Record<string, unknown>): Repository {
    return createRepository(env);
  }
}

export class EventHub extends BaseEventHub {
  protected getRepository(env: Record<string, unknown>): Repository {
    return createRepository(env);
  }
}
