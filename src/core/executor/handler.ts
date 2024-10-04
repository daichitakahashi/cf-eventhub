import type { EventPayload } from "../type";

/** @internal */
export const handler = Symbol();

export interface Handler {
  [handler]: true;
  handle(payload: EventPayload): Promise<"complete" | "ignored" | "failed">;
}

export const isHandler = (dest: NonNullable<unknown>): dest is Handler => {
  return typeof dest === "object" && handler in dest && dest[handler] === true;
};
