import type { EventPayload } from "../type";

export interface Handler {
  handle(payload: EventPayload): Promise<"complete" | "ignored" | "failed">;
}

export const isHandler = (dest: NonNullable<unknown>): dest is Handler => {
  return typeof dest === "object" && "handle" in dest;
};

/** @internal */
export const validHandlerResult = (
  result: unknown,
): result is "complete" | "ignored" | "failed" => {
  return ["complete", "ignored", "failed"].includes(result as string);
};
