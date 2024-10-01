import { WorkerEntrypoint } from "cloudflare:workers";

import type { EventPayload } from "../type";

const handler = Symbol();

export interface Handler {
  [handler]: true;
  handle(payload: EventPayload): Promise<"complete" | "ignored" | "failed">;
}

export abstract class RpcHandler extends WorkerEntrypoint implements Handler {
  [handler] = true as const;

  abstract handle(
    payload: EventPayload,
  ): Promise<"complete" | "ignored" | "failed">;
}

export const isHandler = (dest: NonNullable<unknown>): dest is Handler => {
  return typeof dest === "object" && handler in dest && dest[handler] === true;
};
