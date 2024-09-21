import { WorkerEntrypoint } from "cloudflare:workers";

import type { QueueMessage } from "../type";

export class Executor extends WorkerEntrypoint {
  dispatch(
    msg: QueueMessage,
  ): Promise<"complete" | "ignored" | "failed" | "misconfigured" | "notfound"> {
    throw new Error("not implemented");
  }
}
