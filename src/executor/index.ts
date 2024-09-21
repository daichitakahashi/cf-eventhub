import { WorkerEntrypoint } from "cloudflare:workers";
import { fromAsyncThrowable, ok } from "neverthrow";

import type { Persistence } from "../persistence";
import type { QueueMessage } from "../type";
import type { Handler } from "./handler";

interface Env {
  EVENTHUB_DB_DSN: string;
}

export class Executor extends WorkerEntrypoint<Env> {
  private p: Persistence;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    throw new Error("not implemented");
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
      const handler = findDestinationHandler(dispatchResult.value.destination);
      if (!handler) {
        return ok("misconfigured" as const);
      }

      const handleResult = await fromAsyncThrowable(() => {
        return handler.handle(dispatch.payload);
      })();
      const result = handleResult.unwrapOr("failed");

      // FIXME: record execution result

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

const findDestinationHandler = (d: string): Handler | null => {
  throw new Error("not implemented");
};
