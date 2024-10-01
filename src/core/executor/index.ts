import { WorkerEntrypoint } from "cloudflare:workers";
import { fromAsyncThrowable, ok } from "neverthrow";

import { type DispatchExecution, appendExecutionLog } from "../model";
import type { Repository } from "../repository";
import type { QueueMessage } from "../type";
import { type Handler, isHandler } from "./handler";

export abstract class Executor<
  Env extends Record<string, unknown> = Record<string, unknown>,
> extends WorkerEntrypoint<Env> {
  private repo: Promise<Repository>;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    this.repo = this.getRepository();
  }

  protected abstract getRepository(): Promise<Repository>;

  private findDestinationHandler(d: string): Handler | null {
    const dest = this.env[d];
    if (!dest) {
      return null;
    }
    return isHandler(dest) ? dest : null;
  }

  async dispatch(msg: QueueMessage): Promise<DispatchExecution["result"]> {
    const repo = await this.repo;
    const result = await repo.enterTransactionalScope(async (tx) => {
      const dispatchResult = await tx.getDispatch(msg.dispatchId);
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

      const result = await fromAsyncThrowable(async () => {
        return handler
          ? handler.handle(event.payload)
          : ("misconfigured" as const);
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
