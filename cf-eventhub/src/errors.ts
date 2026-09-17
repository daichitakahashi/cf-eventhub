/** Stable categories exposed by intentional cf-eventhub errors over RPC. */
export type EventHubErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_CURSOR"
  | "DESTINATION_NOT_CONFIGURED"
  | "INVALID_DESTINATION_BINDING"
  | "INSTANCE_MISMATCH";

export type EventHubError = Error & {
  code: EventHubErrorCode;
};

/**
 * Creates an Error whose public fields are enumerable own properties so they
 * survive Durable Object RPC serialization. Consumers should inspect `code`,
 * rather than relying on `instanceof` across the RPC boundary.
 */
export const eventHubError = (
  code: EventHubErrorCode,
  message: string,
): EventHubError => {
  const error = new Error(message) as EventHubError;
  Object.defineProperties(error, {
    name: {
      value: "EventHubError",
      enumerable: true,
      configurable: true,
      writable: true,
    },
    message: {
      value: message,
      enumerable: true,
      configurable: true,
      writable: true,
    },
    code: { value: code, enumerable: true, configurable: true, writable: true },
  });
  return error;
};

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
