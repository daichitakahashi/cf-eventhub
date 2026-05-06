type JSONPrimitive = string | boolean | number | null | undefined;
type JSONArray = readonly NoInfer<JSONPrimitive | JSONObject | JSONArray>[];

export type JSONObject = {
	[key: string]: NoInfer<JSONPrimitive | JSONArray | JSONObject>;
};

export type EventPayload = JSONObject;
