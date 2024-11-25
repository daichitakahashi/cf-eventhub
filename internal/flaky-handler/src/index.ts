import { RpcHandler } from "cf-eventhub";
import type { EventPayload } from "cf-eventhub/core";

export default class FlakyHandler extends RpcHandler {
  async handle(
    _payload: EventPayload,
  ): Promise<"complete" | "ignored" | "failed"> {
    const n = Math.floor(Math.random() * 100);
    const result =
      n % 2 === 0 ? "failed" : n % 3 === 0 ? "ignored" : "complete";
    console.log("flaky handler:", result);
    return result;
  }
}
