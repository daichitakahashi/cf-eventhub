import type { Executor as BaseExecutor } from "../core/executor";
import { RpcExecutor } from "../core/executor/rpc";
import { RpcEventHub } from "../core/hub/rpc";
import type { Repository } from "../core/repository";
import type { QueueMessage } from "../core/type";
import { DevRepository } from "./repository";

class Executor<Env extends Record<string, unknown> = Record<string, unknown>>
  extends RpcExecutor<Env>
  implements BaseExecutor
{
  protected getRepository(): Repository {
    return new DevRepository();
  }
}

export class EventHub<
  Env extends Record<string, unknown> = Record<string, unknown>,
> extends RpcEventHub<Env> {
  private executor: Executor<Env>;
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    this.executor = new Executor(ctx, env);
  }
  protected getRepository(): Repository {
    return new DevRepository();
  }
  queue(batch: MessageBatch<QueueMessage>) {
    return this.executor.queue(batch);
  }
}
