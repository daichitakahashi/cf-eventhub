/** Stable categories exposed by intentional cf-eventhub errors over RPC. */
export type EventHubErrorCode =
  | "INVALID_ARGUMENT"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_CURSOR"
  | "DESTINATION_NOT_CONFIGURED"
  | "INVALID_DESTINATION_BINDING"
  | "INSTANCE_MISMATCH"
  | "INTERNAL_ERROR";

export type ResultError = {
  ok: false;
  error: {
    code: EventHubErrorCode;
    message: string;
  };
};

export type ResultOk<T = void> =
  // biome-ignore lint/suspicious/noConfusingVoidType: void distinguishes value-less RPC success results.
  [T] extends [void] ? { ok: true } : { ok: true; value: T };

export type Result<T = void> = ResultOk<T> | ResultError;

export function resultOk(): Result;
export function resultOk<T>(value: T): Result<T>;
export function resultOk<T>(value?: T): Result<T> | Result {
  return (value === undefined ? { ok: true } : { ok: true, value }) as
    | Result<T>
    | Result;
}

export const resultError = (
  code: EventHubErrorCode,
  message: string,
): ResultError => ({ ok: false, error: { code, message } });

type SerializableErrorCause =
  | null
  | boolean
  | number
  | string
  | SerializableErrorCause[]
  | { [key: string]: SerializableErrorCause };

export type SerializedError = {
  name?: string;
  message: string;
  stack?: string;
  cause?: SerializableErrorCause;
};

const serializeValue = (
  value: unknown,
  seen: WeakSet<object>,
): SerializableErrorCause => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "bigint" || typeof value === "symbol") {
    return String(value);
  }
  if (typeof value === "function")
    return `[Function ${value.name || "anonymous"}]`;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Error) {
    return serializeErrorInternal(value, seen) as {
      [key: string]: SerializableErrorCause;
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, seen));
  }

  const serialized: { [key: string]: SerializableErrorCause } = {};
  for (const key of Object.keys(value)) {
    try {
      serialized[key] = serializeValue(
        (value as Record<string, unknown>)[key],
        seen,
      );
    } catch {
      serialized[key] = "[Unserializable]";
    }
  }
  return serialized;
};

const serializeErrorInternal = (
  error: Error,
  seen: WeakSet<object>,
): SerializedError => ({
  ...(error.name ? { name: error.name } : {}),
  message: error.message,
  ...(error.stack ? { stack: error.stack } : {}),
  ...(error.cause === undefined
    ? {}
    : { cause: serializeValue(error.cause, seen) }),
});

const safeString = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return "[Unstringifiable thrown value]";
  }
};

/** Converts any thrown value into data that is safe for structured logging. */
export const serializeError = (error: unknown): SerializedError => {
  try {
    if (error instanceof Error) {
      const seen = new WeakSet<object>();
      seen.add(error);
      return serializeErrorInternal(error, seen);
    }
    if (
      (typeof error === "object" && error !== null) ||
      typeof error === "function"
    ) {
      return {
        message: safeString(error),
        cause: serializeValue(error, new WeakSet<object>()),
      };
    }
  } catch {
    return { message: safeString(error) };
  }
  return { message: safeString(error) };
};

/**
 * Runs an RPC implementation that returns expected failures explicitly.
 * Only unexpected exceptions are caught and converted to `INTERNAL_ERROR`.
 */
export const rpcBoundary = async <T>(
  operation: string,
  callback: () => Result<T> | Promise<Result<T>>,
  context: Record<string, unknown> = {},
): Promise<Result<T>> => {
  try {
    return await callback();
  } catch (error) {
    console.error("eventhub: RPC request failed", {
      operation,
      ...context,
      error: serializeError(error),
    });
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "eventhub: internal error",
      },
    };
  }
};
