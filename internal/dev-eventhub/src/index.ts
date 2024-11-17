import type { RpcEnv } from "../../../cf-eventhub/src/core/hub/rpc";
import { EventHub } from "../../../cf-eventhub/src/dev";

export default class Hub extends EventHub<RpcEnv> {
  async fetch(_: Request): Promise<Response> {
    const result = await this.listDispatches();
    return new Response(JSON.stringify(result, null, 2));
  }
}
