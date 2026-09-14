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

/** Converts an authored payload into the canonical representation used by JSON. */
export const normalizeEventPayload = (payload: EventPayload): EventPayload => {
  try {
    const body = JSON.stringify(payload);
    if (body === undefined) {
      throw new Error("payload has no JSON representation");
    }

    const normalized = JSON.parse(body) as unknown;
    if (
      typeof normalized !== "object" ||
      normalized === null ||
      Array.isArray(normalized)
    ) {
      throw new Error("payload is not a JSON object");
    }
    return normalized as EventPayload;
  } catch {
    throw new Error("eventhub: payload must be a JSON-serializable object");
  }
};
