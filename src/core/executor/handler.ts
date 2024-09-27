import { WorkerEntrypoint } from "cloudflare:workers";

import type { EventPayload } from "../type";

const handler = Symbol();

export abstract class Handler extends WorkerEntrypoint {
  abstract handle(
    payload: EventPayload,
  ): Promise<"complete" | "ignored" | "failed">;

  [handler] = true;
}

export const isHandler = (dest: NonNullable<unknown>): dest is Handler => {
  return typeof dest === "object" && handler in dest && dest[handler] === true;
};
