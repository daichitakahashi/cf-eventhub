import type { Logger } from "../core/logger";
import type { RepositoryV2 as Repository } from "../core/repository";
import { type RpcEnv, RpcEventHub } from "../eventhub";
import { RpcExecutor } from "../executor";
import { createRepositoryV2 as createRepository } from "./postgresjs-repository";

export class Executor<
  Env extends Record<string, unknown> = Record<string, unknown>,
> extends RpcExecutor<Env> {
  protected getRepository(logger: Logger): Repository {
    return createRepository(this.env, logger);
  }
}

export class EventHub<Env extends RpcEnv = RpcEnv> extends RpcEventHub<Env> {
  protected getRepository(logger: Logger): Repository {
    return createRepository(this.env, logger);
  }
}

export { createRepository } from "./postgresjs-repository";
