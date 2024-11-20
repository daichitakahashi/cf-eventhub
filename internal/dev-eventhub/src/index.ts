import { RpcExecutor } from "../../../cf-eventhub/src/core/executor/rpc";
import {
  type RpcEnv,
  RpcEventHub,
} from "../../../cf-eventhub/src/core/hub/rpc";
import type { Logger } from "../../../cf-eventhub/src/core/logger";
import type { Repository } from "../../../cf-eventhub/src/core/repository";
import type { QueueMessage } from "../../../cf-eventhub/src/core/type";
import { DevRepository } from "../../../cf-eventhub/src/dev/repository";

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
