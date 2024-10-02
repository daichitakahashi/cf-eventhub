import { RpcExecutor } from "../core/executor/rpc";
import { RpcEventHub } from "../core/hub/rpc";
import type { Repository } from "../core/repository";
import { createRepository } from "./postgresjs-repository";

export class Executor<
  Env extends Record<string, unknown> = Record<string, unknown>,
> extends RpcExecutor<Env> {
  protected getRepository(): Repository {
    return createRepository(this.env);
  }
}

export class EventHub<
  Env extends Record<string, unknown> = Record<string, unknown>,
> extends RpcEventHub<Env> {
  protected getRepository(): Repository {
    return createRepository(this.env);
  }
}
