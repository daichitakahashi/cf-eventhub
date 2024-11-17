import { RpcHandler } from "../../../cf-eventhub/src/core/executor/rpc";
import type { EventPayload } from "../../../cf-eventhub/src/core/type";

export default class FlakyHandler extends RpcHandler {
  async handle(
    _payload: EventPayload,
  ): Promise<"complete" | "ignored" | "failed"> {
    const n = Math.random();
    if (n % 2 === 0) {
      return "failed";
    }
    if (n % 3 === 0) {
      return "ignored";
    }
    return "complete";
  }
}
