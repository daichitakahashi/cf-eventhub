export { Config, RouteConfig } from "./hub/routing";
export type { QueueMessage } from "./hub/queue";

type JSONPrimitive = string | boolean | number | null;
type JSONArray = NoInfer<JSONPrimitive | JSONObject | JSONArray>[];
export type JSONObject = {
  [key: string]: NoInfer<JSONPrimitive | JSONArray | JSONObject>;
};

export type EventPayload = JSONObject;

type StructuredClonable = Date;

export type SymbolStripped<T> = {
  [K in keyof T as K extends string ? K : never]: T[K] extends (infer E)[]
    ? SymbolStripped<E>[]
    : T[K] extends StructuredClonable
      ? T[K]
      : T[K] extends object
        ? SymbolStripped<T[K]>
        : T[K];
};
