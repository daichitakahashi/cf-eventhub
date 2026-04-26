import { ok } from "neverthrow";

import { formatException } from "../../utils/format-exception";
import type { Logger } from "../logger";
import {
  type CreatedEvent,
  type DispatchExecution,
  type OngoingDispatch,
  appendExecutionLog,
} from "../model";
import type { MutationRepository, Repository } from "../repository";
import { nextDelay } from "../retry-delay";
import type { EventPayload, QueueMessage } from "../type";
import {
  type Handler,
  isHandler,
  isR2Bucket,
  validHandlerResult,
} from "./handler";

export type DispatchAttemptResult =
  | { type: "postponed"; delaySeconds: number }
  | {
      type: "dispatched";
      result: DispatchExecution["result"];
    };

export class Dispatcher {
  constructor(
    private repo: Repository,
    private env: Record<string, unknown>,
    private logger: Logger,
  ) {}

  private findDestinationHandler(d: string): Handler | R2Bucket | null {
    const dest = this.env[d];
    if (!dest) {
      return null;
    }
    return isHandler(dest) ? dest : isR2Bucket(dest) ? dest : null;
  }

  /**
   * Runs dispatch execution under a single transactional lock.
   *
   * When the same dispatch was already attempted via fast path, Queue fallback
   * may need to wait until the retry window opens. In that case this returns
   * `postponed` instead of starting the handler execution immediately.
   */
  async attemptDispatch(
    msg: QueueMessage,
    queueAttempts = 0,
    now = new Date(),
  ): Promise<DispatchAttemptResult> {
    const result = await this.repo.mutate<DispatchAttemptResult, never>(
      async (tx) => {
        const dispatchResult = await tx.getTargetDispatch(msg.dispatchId);
        if (dispatchResult.isErr()) {
          return ok({
            type: "dispatched" as const,
            result: "failed" as const,
          });
        }
        if (
          dispatchResult.value === null ||
          dispatchResult.value.dispatch.status !== "ongoing"
        ) {
          return ok({
            type: "dispatched" as const,
            result: "notfound" as const,
          });
        }

        const { dispatch } = dispatchResult.value;
        // Fast path executes the same dispatch before the queued message arrives.
        // If the fast path already failed and the next retry window has not opened
        // yet, consuming the queued message immediately would start the retry too
        // early. In that case, tell the caller to re-delay the queued message so
        // that Queue fallback follows the same retry schedule.
        //
        // `queueAttempts` is used only for Queue consumers. Fast path requests do
        // not increment Queue attempts, so a queued message should not be delayed
        // unless the dispatch already has at least the same number of executions.
        if (dispatch.executionLog.length < queueAttempts) {
          return this.dispatchInTransaction(
            dispatchResult.value.event,
            dispatch,
            tx,
          );
        }
        const postponedDelaySeconds = this.getPostponedRetryDelaySeconds(
          dispatch,
          msg,
          now,
        );
        if (postponedDelaySeconds) {
          return ok({
            type: "postponed" as const,
            delaySeconds: postponedDelaySeconds,
          });
        }

        return this.dispatchInTransaction(
          dispatchResult.value.event,
          dispatch,
          tx,
        );
      },
    );
    return result.match(
      (attempt) => attempt,
      (e) => {
        this.logger.error("error on dispatch", { error: formatException(e) });
        return {
          type: "dispatched",
          result: "failed",
        };
      },
    );
  }

  /**
   * @deprecated Use `attemptDispatch()` to preserve postponed retry semantics.
   */
  async dispatch(msg: QueueMessage): Promise<DispatchExecution["result"]> {
    const result = await this.attemptDispatch(msg);
    return result.type === "dispatched" ? result.result : "failed";
  }

  private getPostponedRetryDelaySeconds(
    dispatch: {
      executionLog: readonly {
        result: string;
        executedAt: Date;
      }[];
    },
    msg: QueueMessage,
    now: Date,
  ): number | undefined {
    const lastExecution =
      dispatch.executionLog[dispatch.executionLog.length - 1];
    if (!lastExecution || lastExecution.result !== "failed") {
      return undefined;
    }

    const delaySeconds = nextDelay({
      retryDelay: msg.retryDelay,
      attempts: dispatch.executionLog.length,
    });
    if (!delaySeconds) {
      return undefined;
    }

    const dueAt = lastExecution.executedAt.getTime() + delaySeconds * 1000;
    const remainingSeconds = Math.ceil((dueAt - now.getTime()) / 1000);
    return remainingSeconds > 0 ? remainingSeconds : undefined;
  }

  private async dispatchInTransaction(
    event: CreatedEvent,
    dispatch: OngoingDispatch,
    tx: MutationRepository,
  ) {
    return this.runHandler(event, dispatch).then(async (result) => {
      const appendedDispatch = appendExecutionLog(dispatch, {
        result,
        executedAt: new Date(),
      });
      const saveResult = await tx.saveDispatch(appendedDispatch);
      return ok({
        type: "dispatched" as const,
        result: saveResult.isErr() ? ("failed" as const) : result,
      });
    });
  }

  private async runHandler(
    event: CreatedEvent,
    dispatch: OngoingDispatch,
  ): Promise<DispatchExecution["result"]> {
    try {
      const handler = this.findDestinationHandler(dispatch.destination);
      if (!handler) {
        this.logger.error(`handler not found: ${dispatch.destination}`);
        return "misconfigured" as const;
      }

      if (isHandler(handler)) {
        const result = await handler.handle(event.payload as EventPayload);
        if (!validHandlerResult(result)) {
          this.logger.error(
            `got invalid result from handler ${dispatch.destination}: ${result}`,
          );
          return "failed" as const;
        }
        return result;
      }

      const objectKey = `${new Date().toISOString()}-${dispatch.id}`;
      await handler.put(objectKey, JSON.stringify(event.payload));
      return "complete" as const;
    } catch (e) {
      this.logger.error(`handler ${dispatch.destination} rejected`, {
        error: formatException(e),
      });
      return "failed" as const;
    }
  }
}
