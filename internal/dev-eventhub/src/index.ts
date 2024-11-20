import type { RpcEnv } from "../../../cf-eventhub/src/core/hub/rpc";
import type { Repository } from "../../../cf-eventhub/src/core/repository";
import { EventHub } from "../../../cf-eventhub/src/dev";
import { DevRepository } from "../../../cf-eventhub/src/dev/repository";

const repo = new DevRepository();

export default class Hub extends EventHub<RpcEnv> {
  protected getRepository(): Repository {
    return repo;
  }
  async fetch(_: Request): Promise<Response> {
    const result = await this.listDispatches();
    return new Response(JSON.stringify(result, null, 2));
  }
}
