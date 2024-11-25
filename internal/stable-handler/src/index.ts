import { RpcHandler } from "cf-eventhub";
import type { EventPayload } from "cf-eventhub/core";

export default class StableHandler extends RpcHandler {
  async handle(
    payload: EventPayload,
  ): Promise<"complete" | "ignored" | "failed"> {
    console.log("stable handler:", payload);
    return "complete";
  }
}
