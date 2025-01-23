import * as jsonpath from "jsonpath";
import * as v from "valibot";

const Path = v.pipe(v.string(), v.minLength(1));
const JSONPrimitive = v.union([v.string(), v.number(), v.boolean(), v.null()]);

const comparatorShape = {
  path: Path,
  exact: v.optional(v.never()),
  match: v.optional(v.never()),
  exists: v.optional(v.never()),
  lte: v.optional(v.never()),
  gte: v.optional(v.never()),
  lt: v.optional(v.never()),
  gt: v.optional(v.never()),
};

const Comparator = v.union([
  // exact
  v.object({
    ...comparatorShape,
    exact: JSONPrimitive,
  }),
  // match
  v.object({
    ...comparatorShape,
    match: v.pipe(
      v.string(),
      v.transform((s) => new RegExp(s)),
    ),
  }),
  // exists
  v.object({
    ...comparatorShape,
    exists: v.literal(true),
  }),
  // number comparison(lte)
  v.object({
    ...comparatorShape,
    lte: v.number(),
  }),
  // number comparison(gte)
  v.object({
    ...comparatorShape,
    gte: v.number(),
  }),
  // number comparison(lt)
  v.object({
    ...comparatorShape,
    lt: v.number(),
  }),
  // number comparison(gt)
  v.object({
    ...comparatorShape,
    gt: v.number(),
  }),
]);
type ComparatorInput = v.InferInput<typeof Comparator>;
type Comparator = v.InferOutput<typeof Comparator>;

type LogicalOperatorInput =
  | {
      allOf: ConditionInput[];
      anyOf?: never;
      not?: never;
    }
  | {
      allOf?: never;
      anyOf: ConditionInput[];
      not?: never;
    }
  | {
      allOf?: never;
      anyOf?: never;
      not: ConditionInput;
    };
type LogicalOperator =
  | {
      allOf: Condition[];
      anyOf?: never;
      not?: never;
    }
  | {
      allOf?: never;
      anyOf: Condition[];
      not?: never;
    }
  | {
      allOf?: never;
      anyOf?: never;
      not: Condition;
    };
type ConditionInput = ComparatorInput | LogicalOperatorInput;
type Condition = Comparator | LogicalOperator;

const LogicalOperator: v.GenericSchema<LogicalOperatorInput, LogicalOperator> =
  v.union([
    v.object({
      allOf: v.lazy(() => v.array(Condition)),
    }),
    v.object({
      anyOf: v.lazy(() => v.array(Condition)),
    }),
    v.object({
      not: v.lazy(() => Condition),
    }),
  ]);

const Condition = v.union([Comparator, LogicalOperator]);

const Route = v.object({
  condition: Condition,
  destination: v.pipe(v.string(), v.minLength(1)),
  delaySeconds: v.optional(v.number()),
  maxRetries: v.optional(v.number()),
});

/**
 * Route configuration schema.
 */
export const Config = v.object({
  defaultDelaySeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0)),
  ),
  defaultMaxRetries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  routes: v.array(Route),
});
export type ConfigInput = v.InferInput<typeof Config>;
export type Config = v.InferOutput<typeof Config>;

const immediate = <T>(f: () => T) => f();

const match = (message: unknown, cond: Comparator) => {
  const values = immediate(() => {
    try {
      return jsonpath.query(message, cond.path);
    } catch {
      return [];
    }
  });
  if (values.length === 0) {
    return false;
  }

  // Construct matchers
  let match: (v: unknown) => boolean = () => false;
  if (cond.exact !== undefined) {
    match = (v: unknown) => v === cond.exact;
  } else if (cond.match) {
    const pattern = cond.match;
    match = (v: unknown) => typeof v === "string" && pattern.test(v);
  } else if (cond.exists) {
    match = () => true;
  } else if (cond.lte) {
    match = (v: unknown) => typeof v === "number" && v <= cond.lte;
  } else if (cond.gte) {
    match = (v: unknown) => typeof v === "number" && v >= cond.gte;
  } else if (cond.lt) {
    match = (v: unknown) => typeof v === "number" && v < cond.lt;
  } else if (cond.gt) {
    match = (v: unknown) => typeof v === "number" && v > cond.gt;
  }

  return values.some(match);
};

const matchCond =
  (message: unknown) =>
  (cond: Condition): boolean => {
    if ("path" in cond) {
      return match(message, cond);
    }
    if (cond.not) {
      return !matchCond(message)(cond.not);
    }
    if (cond.allOf) {
      return cond.allOf.every(matchCond(message));
    }
    return cond.anyOf.some(matchCond(message));
  };

type FoundRoute = {
  destination: string;
  delaySeconds: number | null;
  maxRetries: number | null;
};

export const findRoutes = (c: Config, message: unknown): FoundRoute[] => {
  const matcher = matchCond(message);

  return c.routes
    .filter((r) => matcher(r.condition))
    .map(({ destination, delaySeconds, maxRetries }) => ({
      destination,
      delaySeconds: delaySeconds || c.defaultDelaySeconds || null,
      maxRetries: maxRetries || c.defaultMaxRetries || null,
    }));
};
