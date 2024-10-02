import type { Executor as BaseExecutor } from "../core/executor";
import { RpcExecutor } from "../core/executor/rpc";
import { RpcEventHub } from "../core/hub/rpc";
import type { Repository } from "../core/repository";
import { DevRepository } from "./repository";

export class Executor<
    Env extends Record<string, unknown> = Record<string, unknown>,
  >
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
  protected getRepository(): Repository {
    return new DevRepository();
  }
}
