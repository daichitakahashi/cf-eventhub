import { type Result, resultError, resultOk } from "../errors";

type JSONPrimitive = string | boolean | number | null | undefined;
type JSONArray = readonly NoInfer<JSONPrimitive | JSONObject | JSONArray>[];

/**
 * Event payload object.
 *
 * `undefined` is accepted at the type level for authoring convenience, but
 * EventHub treats it the same as an absent property because payloads are
 * handled as JSON-serialized data.
 */
export type JSONObject = {
  [key: string]: NoInfer<JSONPrimitive | JSONArray | JSONObject>;
};

export type EventPayload = JSONObject;

export type SerializedEventPayload = {
  payload: EventPayload;
  serializedPayload: string;
};

/** Serializes an authored payload without using exceptions for invalid input. */
export const serializeEventPayload = (
  payload: EventPayload,
): Result<SerializedEventPayload> => {
  let serializedPayload: string | undefined;
  try {
    serializedPayload = JSON.stringify(payload);
  } catch {
    return resultError(
      "INVALID_ARGUMENT",
      "eventhub: payload must be a JSON-serializable object",
    );
  }
  if (serializedPayload === undefined) {
    return resultError(
      "INVALID_ARGUMENT",
      "eventhub: payload must be a JSON-serializable object",
    );
  }
  const normalized = JSON.parse(serializedPayload) as unknown;
  if (
    typeof normalized !== "object" ||
    normalized === null ||
    Array.isArray(normalized)
  ) {
    return resultError(
      "INVALID_ARGUMENT",
      "eventhub: payload must be a JSON-serializable object",
    );
  }
  return resultOk({
    payload: normalized as EventPayload,
    serializedPayload,
  });
};

/** Converts an authored payload into the canonical representation used by JSON. */
export const normalizeEventPayload = (
  payload: EventPayload,
): Result<EventPayload> => {
  const serialized = serializeEventPayload(payload);
  if (!serialized.ok) return serialized;
  return resultOk(serialized.value.payload);
};
