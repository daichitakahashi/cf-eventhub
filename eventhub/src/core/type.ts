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
