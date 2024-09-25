import { WorkerEntrypoint } from "cloudflare:workers";
import { fromAsyncThrowable, ok } from "neverthrow";

import type { Persistence } from "../persistence";
import type { QueueMessage } from "../type";
import { type Handler, isHandler } from "./handler";

type Env = {
  EVENTHUB_DB_DSN: string;
} & Record<string, unknown>;

export class Executor extends WorkerEntrypoint<Env> {
  private p: Persistence;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    throw new Error("not implemented");
  }

  private findDestinationHandler(d: string): Handler | null {
    const dest = this.env[d];
    if (!dest) {
      return null;
    }
    return isHandler(dest) ? dest : null;
  }

  async dispatch(
    msg: QueueMessage,
  ): Promise<"complete" | "ignored" | "failed" | "misconfigured" | "notfound"> {
    const result = await this.p.enterTransactionalScope(async (tx) => {
      const dispatchResult = await tx.getDispatch(msg.dispatchId);
      if (dispatchResult.isErr()) {
        switch (dispatchResult.error) {
          case "NOT_FOUND":
            return ok("notfound" as const);
          case "INTERNAL_SERVER_ERROR":
            return ok("failed" as const);
          default: {
            const _: never = dispatchResult.error;
            throw new Error("impossible path");
          }
        }
      }

      // FIXME: handle retry count

      const dispatch = dispatchResult.value;
      const handler = this.findDestinationHandler(
        dispatchResult.value.destination,
      );
      if (!handler) {
        return ok("misconfigured" as const);
      }

      const result = await fromAsyncThrowable(() => {
        return handler.handle(dispatch.payload);
      })().unwrapOr("failed" as const);

      // Save execution result.
      const saveResult = await this.p.saveDispatchExecutionResult(
        dispatch.id,
        result,
      );
      if (saveResult.isErr()) {
        return ok("failed" as const);
      }

      return ok(result);
    });
    return result.match(
      (result) => result,
      (e) => {
        console.error(e); // FIXME:
        return "failed";
      },
    );
  }
}
