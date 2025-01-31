import { type RpcEnv, RpcEventHub, RpcExecutor } from "cf-eventhub";
import type {
  Logger,
  QueueMessage,
  RepositoryV2 as Repository,
} from "cf-eventhub/core";
import { DevRepositoryV2 as DevRepository } from "cf-eventhub/dev";

const repo = new DevRepository();

class Executor extends RpcExecutor<RpcEnv> {
  protected getRepository(_: Logger): Repository {
    return repo;
  }
}

export default class Hub extends RpcEventHub<RpcEnv> {
  protected getRepository(): Repository {
    return repo;
  }
  async fetch(_: Request): Promise<Response> {
    const result = await this.listDispatches();
    return new Response(JSON.stringify(result, null, 2));
  }
  async queue(batch: MessageBatch<QueueMessage>) {
    return new Executor(this.ctx, this.env).queue(batch);
  }
}
