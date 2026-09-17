import { eventHubError } from "../errors";

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

/** Serializes an authored payload and returns its canonical JSON representation. */
export const serializeEventPayload = (
  payload: EventPayload,
): SerializedEventPayload => {
  try {
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload === undefined) {
      throw new Error("payload has no JSON representation");
    }

    const normalized = JSON.parse(serializedPayload) as unknown;
    if (
      typeof normalized !== "object" ||
      normalized === null ||
      Array.isArray(normalized)
    ) {
      throw new Error("payload is not a JSON object");
    }
    return {
      payload: normalized as EventPayload,
      serializedPayload,
    };
  } catch {
    throw eventHubError(
      "INVALID_ARGUMENT",
      "eventhub: payload must be a JSON-serializable object",
    );
  }
};

/** Converts an authored payload into the canonical representation used by JSON. */
export const normalizeEventPayload = (payload: EventPayload): EventPayload =>
  serializeEventPayload(payload).payload;
