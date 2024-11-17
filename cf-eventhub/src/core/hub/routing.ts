import * as jsonpath from "jsonpath";
import * as v from "valibot";

const ExactCondition = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  exact: v.unknown(),
});
const MatchCondition = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  match: v.pipe(
    v.string(),
    v.transform((s) => new RegExp(s)),
  ),
});
const Condition = v.union([ExactCondition, MatchCondition]);
export type Condition = v.InferOutput<typeof Condition>;

const Route = v.object({
  conditions: v.array(Condition),
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
  const matchers: ((v: unknown) => boolean)[] = [];
  if ("exact" in cond) {
    matchers.push((v: unknown) => v === cond.exact);
  } else {
    const pattern = cond.match;
    matchers.push((v: unknown) => typeof v === "string" && pattern.test(v));
  }

  // Apply matchers (AND)
  return values.every((v) => matchers.every((match) => match(v)));
};

export const findRoutes = (c: Config, message: unknown): Route[] =>
  c.routes.filter((r) => r.conditions.every(matchCond(message)));
