import { RpcHandler } from "cf-eventhub";
import type { EventPayload } from "cf-eventhub/core";

import type { Env } from "../worker-configuration";

export default class ProducerHandler extends RpcHandler<Env> {
  async handle(
    payload: EventPayload,
  ): Promise<"complete" | "ignored" | "failed"> {
    console.log("producer handler:", payload);
    await this.env.EVENTHUB.putEvent([
      {
        flaky: true,
      },
    ]);
    return "complete";
  }
}
