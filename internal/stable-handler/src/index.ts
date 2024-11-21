import { RpcHandler } from "../../../cf-eventhub/src/core/executor/rpc";
import type { EventPayload } from "../../../cf-eventhub/src/core/type";

export default class StableHandler extends RpcHandler {
  async handle(
    payload: EventPayload,
  ): Promise<"complete" | "ignored" | "failed"> {
    console.log("stable handler:", payload);
    return "complete";
  }
}
