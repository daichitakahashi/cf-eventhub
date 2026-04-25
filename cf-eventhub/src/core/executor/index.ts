import { fromAsyncThrowable, ok } from "neverthrow";

import { formatException } from "../../utils/format-exception";
import type { Logger } from "../logger";
import { type DispatchExecution, appendExecutionLog } from "../model";
import type { Repository } from "../repository";
import { nextDelay } from "../retry-delay";
import type { QueueMessage } from "../type";
import {
  type Handler,
  isHandler,
  isR2Bucket,
  validHandlerResult,
} from "./handler";

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
   * Returns remaining delay seconds when Queue fallback should be postponed.
   *
   * This is used to keep the Queue consumer aligned with the retry schedule
   * after the same dispatch was already attempted via fast path.
   */
  async getPostponedRetryDelaySeconds(
    msg: QueueMessage,
    queueAttempts = 0,
    now = new Date(),
  ): Promise<number | undefined> {
    const result = await this.repo.mutate(async (tx) => {
      const dispatchResult = await tx.getTargetDispatch(msg.dispatchId);
      if (dispatchResult.isErr()) {
        return ok(undefined);
      }
      if (
        dispatchResult.value === null ||
        dispatchResult.value.dispatch.status !== "ongoing"
      ) {
        return ok(undefined);
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
        return ok(undefined);
      }

      const lastExecution =
        dispatch.executionLog[dispatch.executionLog.length - 1];
      if (!lastExecution || lastExecution.result !== "failed") {
        return ok(undefined);
      }

      const delaySeconds = nextDelay({
        retryDelay: msg.retryDelay,
        attempts: dispatch.executionLog.length,
      });
      if (!delaySeconds) {
        return ok(undefined);
      }

      const dueAt = lastExecution.executedAt.getTime() + delaySeconds * 1000;
      const remainingSeconds = Math.ceil((dueAt - now.getTime()) / 1000);
      return ok(remainingSeconds > 0 ? remainingSeconds : undefined);
    });
    return result.unwrapOr(undefined);
  }

  async dispatch(msg: QueueMessage): Promise<DispatchExecution["result"]> {
    const result = await this.repo.mutate(async (tx) => {
      const dispatchResult = await tx.getTargetDispatch(msg.dispatchId);
      if (dispatchResult.isErr()) {
        return ok("failed" as const);
      }

      if (
        dispatchResult.value === null ||
        dispatchResult.value.dispatch.status !== "ongoing"
      ) {
        return ok("notfound" as const);
      }
      const { event, dispatch } = dispatchResult.value;

      const result = await fromAsyncThrowable(
        async () => {
          const handler = this.findDestinationHandler(dispatch.destination);
          if (!handler) {
            this.logger.error(`handler not found: ${dispatch.destination}`);
            return "misconfigured" as const;
          }

          // call handler
          if (isHandler(handler)) {
            const result = await handler.handle(event.payload);
            if (!validHandlerResult(result)) {
              this.logger.error(
                `got invalid result from handler ${dispatch.destination}: ${result}`,
              );
              return "failed" as const;
            }
            return result;
          }

          // or put to R2 bucket directly
          const objectKey = `${new Date().toISOString()}-${dispatch.id}`;
          await handler.put(objectKey, JSON.stringify(event.payload));
          return "complete" as const;
        },
        (e) => {
          this.logger.error(`handler ${dispatch.destination} rejected`, {
            error: formatException(e),
          });
          return "failed" as const;
        },
      )().unwrapOr("failed" as const); // impossible path

      // Save execution result.
      const appendedDispatch = appendExecutionLog(dispatch, {
        result,
        executedAt: new Date(),
      });
      const saveResult = await tx.saveDispatch(appendedDispatch);
      if (saveResult.isErr()) {
        return ok("failed" as const);
      }

      return ok(result);
    });
    return result.match(
      (result) => result,
      (e) => {
        this.logger.error("error on dispatch", { error: formatException(e) });
        return "failed";
      },
    );
  }
}
