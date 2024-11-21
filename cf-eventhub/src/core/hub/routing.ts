import * as jsonpath from "jsonpath";
import * as v from "valibot";

const BaseCondition = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
});
const JSONPrimitive = v.union([v.string(), v.number(), v.boolean(), v.null()]);

const ExactCondition = v.object({
  ...BaseCondition.entries,
  exact: JSONPrimitive,
});
const MatchCondition = v.object({
  ...BaseCondition.entries,
  match: v.pipe(
    v.string(),
    v.transform((s) => new RegExp(s)),
  ),
});
const ArrayIncludesCondition = v.object({
  ...BaseCondition.entries,
  includes: JSONPrimitive,
});
const HasCondition = v.object({
  ...BaseCondition.entries,
  has: v.string(),
});
const Condition = v.union([
  ExactCondition,
  MatchCondition,
  ArrayIncludesCondition,
  HasCondition,
]);
export type Condition = v.InferOutput<typeof Condition>;

const Route = v.object({
  conditions: v.array(Condition),
  operator: v.optional(v.union([v.literal("AND"), v.literal("OR")]), "AND"),
  destination: v.pipe(v.string(), v.minLength(1)),
  delaySeconds: v.optional(v.number()),
  maxRetries: v.optional(v.number()),
});
export type Route = v.InferOutput<typeof Route>;

export const RouteConfig = v.array(Route);
export type RouteConfig = v.InferOutput<typeof RouteConfig>;

/**
 * Route configuration schema.
 */
export const Config = v.object({
  defaultDelaySeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0)),
  ),
  defaultMaxRetries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  routes: RouteConfig,
});
export type Config = v.InferOutput<typeof Config>;

const matchCond = (message: unknown) => (cond: Condition) => {
  const values = jsonpath.query(message, cond.path);
  if (values.length === 0) {
    return false;
  }

  // Construct matchers
  let match: (v: unknown) => boolean = () => false;
  if ("exact" in cond) {
    match = (v: unknown) => v === cond.exact;
  } else if ("match" in cond) {
    const pattern = cond.match;
    match = (v: unknown) => typeof v === "string" && pattern.test(v);
  } else if ("includes" in cond) {
    match = (v: unknown) => Array.isArray(v) && v.includes(cond.includes);
  } else if ("has" in cond) {
    match = (v: unknown) => typeof v === "object" && !!v && cond.has in v;
  }

  return values.some(match);
};

export const findRoutes = (c: Config, message: unknown): Route[] =>
  c.routes.filter((r) =>
    r.operator === "AND"
      ? r.conditions.every(matchCond(message))
      : r.conditions.some(matchCond(message)),
  );
