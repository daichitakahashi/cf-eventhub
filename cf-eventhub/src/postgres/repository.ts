import {
  type ExtractTablesWithRelations,
  Table,
  aliasedTable,
  and,
  desc,
  eq,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type {
  PostgresJsDatabase,
  PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";
import {
  type Result,
  err,
  fromAsyncThrowable,
  fromThrowable,
  ok,
} from "neverthrow";

import type { Logger } from "../core/logger";
import {
  type CreatedEvent,
  type Dispatch,
  type Event,
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
import type {
  EventWithDispatches,
  MutationRepository,
  Repository,
} from "../core/repository";
import { formatException } from "../utils/format-exception";
import * as schema from "./schema";

type Db = PostgresJsDatabase<typeof schema>;
type Tx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

const encodeContinuationToken = (input: { id: string; createdAt: Date }) =>
  btoa(`${input.id}:${input.createdAt.getTime()}`);

const decodeContinuationToken = fromThrowable(
  (token: string) => {
    const [id, ts] = atob(token).split(":", 2);
    const n = Number.parseInt(ts);
    if (Number.isNaN(n)) {
      throw new Error("invalid timestamp");
    }
    return { id, createdAt: new Date(n) };
  },
  () => {
    return "INVALID_CONTINUATION_TOKEN" as const;
  },
);

/** @internal */
export class PgRepository implements Repository {
  constructor(
    private db: Db,
    private logger: Logger,
  ) {}

  async mutate<T, E>(
    fn: (tx: MutationRepository) => Promise<Result<T, E>>,
  ): Promise<Result<T, "INTERNAL_SERVER_ERROR" | E>> {
    let result: Result<T, E>;

    try {
      await this.db.transaction(async (tx) => {
        result = await fn(new PgMutationRepository(tx, this.logger));
        if (result.isOk()) return;
        tx.rollback();
      });
    } catch (e) {
      this.logger.error("error on enterTransactionalScope", {
        error: formatException(e),
      });
    }

    // @ts-ignore
    if (!result) {
      return err("INTERNAL_SERVER_ERROR" as const);
    }
    return result;
  }

  async readEvent(
    eventId: string,
  ): Promise<Result<EventWithDispatches | null, "INTERNAL_SERVER_ERROR">> {
    const db = this.db;
    const logger = this.logger;
    return fromAsyncThrowable(
      async () => {
        const row = await db.query.events.findFirst({
          with: {
            dispatches: {
              with: {
                executions: {
                  orderBy: schema.dispatchExecutions.executedAt,
                },
                result: true,
              },
              orderBy: schema.dispatches.createdAt,
            },
          },
          where: eq(schema.events.id, eventId),
        });
        if (!row) {
          return null;
        }

        const event = createdEvent(row.id, {
          payload: row.payload,
          createdAt: row.createdAt,
        });
        const dispatches = row.dispatches.map(
          ({ executions, result, ...dispatch }) => {
            let d: Dispatch = ongoingDispatch(dispatch.id, {
              eventId: dispatch.eventId,
              destination: dispatch.destination,
              createdAt: dispatch.createdAt,
              delaySeconds: dispatch.delaySeconds,
              maxRetries: dispatch.maxRetries,
              retryDelay: dispatch.retryDelay,
            });
            if (executions) {
              for (const ex of executions) {
                if (d.status === "ongoing") {
                  d = appendExecutionLog(
                    d,
                    dispatchExecution(
                      ex.id,
                      ex.result,
                      new Date(ex.executedAt),
                    ),
                  );
                }
              }
            }
            if (result?.result === "lost" && d.status === "ongoing") {
              d = makeDispatchLost(d, result.resultedAt);
            }
            return d;
          },
        );

        return { ...event, dispatches };
      },
      (e) => {
        logger.error("error on getEvent", { error: formatException(e) });
        return "INTERNAL_SERVER_ERROR" as const;
      },
    )();
  }

  async readDispatches(
    maxItems: number,
    continuationToken?: string,
    filterByStatus?: Dispatch["status"][],
    orderBy?: "CREATED_AT_ASC" | "CREATED_AT_DESC",
  ): Promise<
    Result<
      { list: Dispatch[]; continuationToken?: string },
      "INTERNAL_SERVER_ERROR" | "INVALID_CONTINUATION_TOKEN"
    >
  > {
    const db = this.db;
    const logger = this.logger;

    let token: { id: string; createdAt: Date } | undefined;
    if (continuationToken) {
      const result = decodeContinuationToken(continuationToken);
      if (result.isErr()) {
        return err(result.error);
      }
      token = result.value;
    }

    const order = orderBy || "CREATED_AT_ASC";
    const statuses = filterByStatus ? [...new Set(filterByStatus)] : undefined;

    return fromAsyncThrowable(
      async () => {
        // Lock non-resulted rows for update.
        const d = aliasedTable(schema.dispatches, "d");
        const targetDispatches = db.$with("target_dispatches").as(
          db
            .select({
              id: d.id,
              result: schema.dispatchResults.result,
              resultedAt: schema.dispatchResults.resultedAt,
            })
            .from(d)
            .leftJoin(
              schema.dispatchResults,
              eq(d.id, schema.dispatchResults.dispatchId),
            )
            .where(
              and(
                token
                  ? order === "CREATED_AT_ASC"
                    ? sql`(${d.createdAt}, ${d.id}) > (${token.createdAt.toISOString()}, ${token.id})`
                    : sql`(${d.createdAt}, ${d.id}) < (${token.createdAt.toISOString()}, ${token.id})`
                  : undefined,
                statuses
                  ? or(
                      ...statuses.map((status) =>
                        status === "ongoing"
                          ? isNull(schema.dispatchResults.dispatchId)
                          : eq(schema.dispatchResults.result, status),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(
              ...(order === "CREATED_AT_ASC"
                ? [d.createdAt, d.id]
                : [desc(d.createdAt), desc(d.id)]),
            )
            .limit(maxItems + 1), // check next item exists
        );

        // Aggregate executions.
        const aliasedExecutions = aliasedTable(schema.dispatchExecutions, "ex");
        const executions = db.$with("executions").as(
          db
            .with(targetDispatches)
            .select({
              dispatchId: aliasedExecutions.dispatchId,
              data: sql<
                | {
                    id: string;
                    result:
                      | "complete"
                      | "ignored"
                      | "failed"
                      | "misconfigured"
                      | "notfound";
                    executed_at: string;
                  }[]
                | null
              >`jsonb_agg(row_to_json("ex") order by "ex"."executed_at")`.as(
                "data",
              ),
            })
            .from(targetDispatches)
            //.where(eq(aliasedExecutions.dispatchId, dispatches.id))
            .innerJoin(
              aliasedExecutions,
              eq(targetDispatches.id, aliasedExecutions.dispatchId),
            )
            .groupBy(aliasedExecutions.dispatchId),
        );

        const rows = await db
          .with(targetDispatches, executions)
          .select({
            dispatch: {
              id: d.id,
              eventId: d.eventId,
              destination: d.destination,
              delaySeconds: d.delaySeconds,
              maxRetries: d.maxRetries,
              retryDelay: d.retryDelay,
              createdAt: d.createdAt,
            },
            executions: executions.data,
            result: targetDispatches.result,
            resultedAt: targetDispatches.resultedAt,
          })
          .from(d)
          .innerJoin(targetDispatches, eq(d.id, targetDispatches.id))
          .leftJoin(executions, eq(d.id, executions.dispatchId))
          .orderBy(
            ...(order === "CREATED_AT_ASC"
              ? [d.createdAt, d.id]
              : [desc(d.createdAt), desc(d.id)]),
          );
        logger.debug("listDispatches: got rows", { rows });

        const hasNextPage = rows.length > maxItems;
        const list = (hasNextPage ? rows.slice(0, -1) : rows).map((row) => {
          let dispatch: Dispatch = ongoingDispatch(row.dispatch.id, {
            eventId: row.dispatch.eventId,
            destination: row.dispatch.destination,
            createdAt: row.dispatch.createdAt,
            delaySeconds: row.dispatch.delaySeconds,
            maxRetries: row.dispatch.maxRetries,
            retryDelay: row.dispatch.retryDelay,
          });
          if (row.executions !== null) {
            for (const e of row.executions) {
              if (dispatch.status === "ongoing") {
                dispatch = appendExecutionLog(
                  dispatch,
                  dispatchExecution(e.id, e.result, new Date(e.executed_at)),
                );
              }
            }
          }
          if (
            row.result === "lost" &&
            row.resultedAt &&
            dispatch.status === "ongoing"
          ) {
            dispatch = makeDispatchLost(dispatch, row.resultedAt);
          }
          return dispatch;
        });
        const last = hasNextPage ? list[list.length - 1] : undefined;

        const result = {
          list,
          continuationToken: last
            ? encodeContinuationToken({
                id: last.id,
                createdAt: last.createdAt,
              })
            : undefined,
        };
        logger.debug("listDispatches: result", { result });
        return result;
      },
      (e) => {
        logger.error("error on listDispatches", { error: formatException(e) });
        return "INTERNAL_SERVER_ERROR" as const;
      },
    )();
  }

  async readEvents(
    maxItems: number,
    continuationToken?: string,
    orderBy?: "CREATED_AT_ASC" | "CREATED_AT_DESC",
  ): Promise<
    Result<
      { list: EventWithDispatches[]; continuationToken?: string },
      "INTERNAL_SERVER_ERROR" | "INVALID_CONTINUATION_TOKEN"
    >
  > {
    const db = this.db;
    const logger = this.logger;
    const order = orderBy || "CREATED_AT_ASC";

    let token: { id: string; createdAt: Date } | undefined;
    if (continuationToken) {
      const result = decodeContinuationToken(continuationToken);
      if (result.isErr()) {
        return err(result.error);
      }
      token = result.value;
    }

    const events = await fromAsyncThrowable(
      () =>
        db.query.events.findMany({
          with: {
            dispatches: {
              with: {
                executions: {
                  orderBy: schema.dispatchExecutions.executedAt,
                },
                result: true,
              },
              orderBy: schema.dispatches.createdAt,
            },
          },
          where: token
            ? order === "CREATED_AT_ASC"
              ? sql`(${schema.events.createdAt}, ${schema.events.id}) > (${token.createdAt.toISOString()}, ${token.id})`
              : sql`(${schema.events.createdAt}, ${schema.events.id}) < (${token.createdAt.toISOString()}, ${token.id})`
            : undefined,
          orderBy:
            order === "CREATED_AT_ASC"
              ? [schema.events.createdAt, schema.events.id]
              : [desc(schema.events.createdAt), desc(schema.events.id)],
          limit: maxItems + 1,
        }),
      (e) => {
        logger.error("error on listEvents", { error: formatException(e) });
        return "INTERNAL_SERVER_ERROR" as const;
      },
    )();
    if (events.isErr()) {
      return err(events.error);
    }
    const hasNextPage = events.value.length > maxItems;

    const list = (hasNextPage ? events.value.slice(0, -1) : events.value).map(
      (e): EventWithDispatches => {
        const event = createdEvent(e.id, {
          payload: e.payload,
          createdAt: e.createdAt,
        });
        const dispatches = e.dispatches.map(
          ({ executions, result, ...dispatch }) => {
            let d: Dispatch = ongoingDispatch(dispatch.id, {
              eventId: dispatch.eventId,
              destination: dispatch.destination,
              createdAt: dispatch.createdAt,
              delaySeconds: dispatch.delaySeconds,
              maxRetries: dispatch.maxRetries,
              retryDelay: dispatch.retryDelay,
            });
            if (executions) {
              for (const ex of executions) {
                if (d.status === "ongoing") {
                  d = appendExecutionLog(
                    d,
                    dispatchExecution(
                      ex.id,
                      ex.result,
                      new Date(ex.executedAt),
                    ),
                  );
                }
              }
            }
            if (result?.result === "lost" && d.status === "ongoing") {
              d = makeDispatchLost(d, result.resultedAt);
            }
            return d;
          },
        );

        return { ...event, dispatches };
      },
    );
    const last = hasNextPage ? list[list.length - 1] : undefined;

    return ok({
      list,
      continuationToken: last
        ? encodeContinuationToken({
            id: last.id,
            createdAt: last.createdAt,
          })
        : undefined,
    });
  }
}

class PgMutationRepository implements MutationRepository {
  constructor(
    private db: Tx,
    private logger: Logger,
  ) {}

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
        this.logger.error("error on createEvents", {
          error: formatException(e),
        });
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
            retryDelay: d.retryDelay,
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
            retryDelay: r.retryDelay,
          }),
        );
      },
      (e) => {
        this.logger.error("error on createDispatches", {
          error: formatException(e),
        });
        return "INTERNAL_SERVER_ERROR" as const;
      },
    )();
  }

  async getTargetDispatch(
    dispatchId: string,
  ): Promise<
    Result<
      { event: CreatedEvent; dispatch: Dispatch } | null,
      "INTERNAL_SERVER_ERROR"
    >
  > {
    const db = this.db;
    const logger = this.logger;
    return fromAsyncThrowable(
      async () => {
        // Aggregate executions.
        const aliasedExecutions = aliasedTable(schema.dispatchExecutions, "ex");
        const executions = db
          .select({
            data: sql<
              | {
                  id: string;
                  result:
                    | "complete"
                    | "ignored"
                    | "failed"
                    | "misconfigured"
                    | "notfound";
                  executedAt: string;
                }[]
              | null
            >`jsonb_agg(row_to_json("ex") order by "ex"."executed_at")`.as(
              "data",
            ),
          })
          .from(aliasedExecutions)
          .where(eq(aliasedExecutions.dispatchId, dispatchId))
          .groupBy(aliasedExecutions.dispatchId)
          .as("executions");

        const dispatches = aliasedTable(schema.dispatches, "d");
        const rows = await db
          .select({
            dispatch: dispatches,
            event: schema.events,
            executions: executions.data,
            result: schema.dispatchResults,
          })
          .from(dispatches)
          .innerJoin(schema.events, eq(dispatches.eventId, schema.events.id))
          .leftJoin(executions, sql`true`)
          .leftJoin(
            schema.dispatchResults,
            eq(dispatches.id, schema.dispatchResults.dispatchId),
          )
          .where(eq(dispatches.id, dispatchId))
          .limit(1)
          .for("update", { of: new Table("d", undefined, "") }); // Workaround: "FOR UPDATE OF" requires unqualified table reference.

        const row = rows.at(0);
        if (!row) {
          return null;
        }

        const event = createdEvent(row.event.id, {
          payload: row.event.payload,
          createdAt: row.event.createdAt,
        });

        let dispatch: Dispatch = ongoingDispatch(row.dispatch.id, {
          eventId: row.event.id,
          destination: row.dispatch.destination,
          createdAt: row.dispatch.createdAt,
          delaySeconds: row.dispatch.delaySeconds,
          maxRetries: row.dispatch.maxRetries,
          retryDelay: row.dispatch.retryDelay,
        });
        if (row.executions !== null) {
          for (const e of row.executions) {
            if (dispatch.status === "ongoing") {
              dispatch = appendExecutionLog(
                dispatch,
                dispatchExecution(e.id, e.result, new Date(e.executedAt)),
              );
            }
          }
        }

        if (dispatch.status === "ongoing" && row.result?.result === "lost") {
          dispatch = makeDispatchLost(dispatch, row.result.resultedAt);
        }

        return { event, dispatch };
      },
      (e) => {
        logger.error("error on getDispatch", { error: formatException(e) });
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
        this.logger.error("error on saveDispatch", {
          error: formatException(e),
        });
        return "INTERNAL_SERVER_ERROR" as const;
      },
    )();
  }
}
