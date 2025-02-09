import { fromAsyncThrowable, ok } from "neverthrow";

import type { Logger } from "../logger";
import { type DispatchExecution, appendExecutionLog } from "../model";
import type { Repository } from "../repository";
import type { QueueMessage } from "../type";
import { type Handler, isHandler, validHandlerResult } from "./handler";

export class Dispatcher {
  constructor(
    private repo: Repository,
    private env: Record<string, unknown>,
    private logger: Logger,
  ) {}

  private findDestinationHandler(d: string): Handler | null {
    const dest = this.env[d];
    if (!dest) {
      return null;
    }
    return isHandler(dest) ? dest : null;
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
      const handler = this.findDestinationHandler(dispatch.destination);
      if (!handler) {
        this.logger.error(`handler not found: ${dispatch.destination}`);
        return ok("misconfigured" as const);
      }

      const result = await fromAsyncThrowable(
        async () => {
          const result = await handler.handle(event.payload);
          if (!validHandlerResult(result)) {
            this.logger.error(
              `got invalid result from handler ${dispatch.destination}: ${result}`,
            );
            return "failed" as const;
          }
          return result;
        },
        (e) => {
          this.logger.error(`handler ${dispatch.destination} rejected`, {
            error: e,
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
        this.logger.error("error on dispatch", { error: e });
        return "failed";
      },
    );
  }
}
