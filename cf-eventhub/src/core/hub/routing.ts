import * as jsonpath from "jsonpath";
import * as v from "valibot";

// TODO: lte, gte, lt, gt

const Path = v.pipe(v.string(), v.minLength(1));
const JSONPrimitive = v.union([v.string(), v.number(), v.boolean(), v.null()]);

const ExactComparator = v.object({
  path: Path,
  exact: JSONPrimitive,
});
const MatchComparator = v.object({
  path: Path,
  match: v.pipe(
    v.string(),
    v.transform((s) => new RegExp(s)),
  ),
});
const ExistsComparator = v.object({
  path: Path,
  exists: v.literal(true),
});
const Comparator = v.union([
  ExactComparator,
  MatchComparator,
  ExistsComparator,
]);
type ComparatorInput = v.InferInput<typeof Comparator>;
type Comparator = v.InferOutput<typeof Comparator>;

type LogicalOperatorInput =
  | {
      allOf: ConditionInput[];
    }
  | {
      anyOf: ConditionInput[];
    }
  | {
      not: ConditionInput;
    };
type LogicalOperator =
  | {
      allOf: Condition[];
    }
  | {
      anyOf: Condition[];
    }
  | {
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
  if ("exact" in cond) {
    match = (v: unknown) => v === cond.exact;
  } else if ("match" in cond) {
    const pattern = cond.match;
    match = (v: unknown) => typeof v === "string" && pattern.test(v);
  } else if (cond.exists === true) {
    match = () => true;
  }

  return values.some(match);
};

const matchCond =
  (message: unknown) =>
  (cond: Condition): boolean => {
    if ("path" in cond) {
      return match(message, cond);
    }
    if ("not" in cond) {
      return !matchCond(message)(cond.not);
    }
    if ("allOf" in cond) {
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
