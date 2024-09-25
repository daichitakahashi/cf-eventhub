import { WorkerEntrypoint } from "cloudflare:workers";

import type { EventPayload } from "../type";

export abstract class Handler extends WorkerEntrypoint {
  abstract handle(
    payload: EventPayload,
  ): Promise<"complete" | "ignored" | "failed">;
}

export const isHandler = (dest: NonNullable<unknown>): dest is Handler => {
  return typeof dest === "object" && "handle" in dest;
};
