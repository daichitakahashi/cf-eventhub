import { WorkerEntrypoint } from "cloudflare:workers";
import { fromAsyncThrowable, ok } from "neverthrow";

import { appendExecutionLog } from "../core/model";
import type { Repository } from "../core/repository";
import type { ExecutionResult, QueueMessage } from "../type";
import { type Handler, isHandler } from "./handler";

export class Executor<
  Env extends Record<string, unknown> = Record<string, unknown>,
> extends WorkerEntrypoint<Env> {
  private repo: Repository;

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

  async dispatch(msg: QueueMessage): Promise<ExecutionResult> {
    const result = await this.repo.enterTransactionalScope(async (tx) => {
      const dispatchResult = await tx.getDispatch(msg.dispatchId);
      if (dispatchResult.isErr()) {
        return ok("failed" as const);
      }

      const { event, dispatch } = dispatchResult.value;
      if (dispatch.status !== "ongoing") {
        return ok("notfound" as const);
      }
      const handler = this.findDestinationHandler(dispatch.destination);
      if (!handler) {
        return ok("misconfigured" as const);
      }

      const result = await fromAsyncThrowable(() => {
        return handler.handle(event.payload);
      })().unwrapOr("failed" as const);

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
        console.error(e); // FIXME:
        return "failed";
      },
    );
  }
}
