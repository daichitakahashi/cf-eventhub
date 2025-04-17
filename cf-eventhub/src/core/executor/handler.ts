import type { EventPayload } from "../type";

export interface Handler {
  handle(payload: EventPayload): Promise<"complete" | "ignored" | "failed">;
}

export const isHandler = (dest: NonNullable<unknown>): dest is Handler => {
  return typeof dest === "object" && "handle" in dest;
};

export const isR2Bucket = (dest: NonNullable<unknown>): dest is R2Bucket => {
  return dest.constructor?.name === "R2Bucket" && "put" in dest;
};

/** @internal */
export const validHandlerResult = (
  result: unknown,
): result is "complete" | "ignored" | "failed" => {
  return ["complete", "ignored", "failed"].includes(result as string);
};
