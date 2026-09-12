import {
  type Token,
  parsePath,
  query,
  queryWithParsedPath,
} from "./jsonpath-lite";
import type { EventPayload, JSONObject } from "./type";

type Destination = Queue | R2Bucket;

export type Destinations<Env extends object> = Extract<
  keyof {
    [K in keyof Env as K extends string
      ? Env[K] extends Destination
        ? K
        : never
      : never]: Env[K];
  },
  string
>;

export type R2Destinations<Env extends object> = Extract<
  keyof {
    [K in keyof Env as K extends string
      ? Env[K] extends R2Bucket
        ? K
        : never
      : never]: Env[K];
  },
  string
>;

export type QueueDestination = {
  kind: "queue";
  queue: Queue<JSONObject>;
};

export type R2Destination = {
  kind: "r2";
  bucket: R2Bucket;
  objectKey?: R2ObjectKeyFactory;
};

export type ResolvedDestination = QueueDestination | R2Destination;

export type R2ObjectKeyContext<Destination extends string = string> = {
  payload: EventPayload;
  payloadId: string;
  deliveryJobId: string;
  destination: Destination;
  instanceId: string;
  instanceName?: string;
};

export type R2ObjectKeyFactory<Destination extends string = string> = (
  context: R2ObjectKeyContext<Destination>,
) => string;

export type RoutingOptions<Env extends object> = {
  r2?: Partial<{
    [Destination in R2Destinations<Env>]: {
      /**
       * Generates object keys for direct delivery to this R2 destination. The
       * factory should return the same key for the same delivery job context.
       */
      objectKey: R2ObjectKeyFactory<Destination>;
    };
  }>;
};

const safe: unique symbol = Symbol();

export interface RoutingStrategy<Env extends object> {
  [safe]: true;
  findRoutes(message: JSONObject): FoundRoute<Env>[];
  resolveDestination(destination: Destinations<Env>): ResolvedDestination;
}

type FoundRoute<Env extends object> = {
  destination: Destinations<Env>;
};

type JSONPrimitive = string | number | boolean | null;

type Comparator = {
  /**
   * JSONPath-like expression to extract values from the message.
   *
   * Supported patterns:
   * - `$.property` - Root-level property access
   * - `$.nested.path` - Nested property access
   * - `$.items[0]` - Array index access
   * - `$.items[*]` - Array wildcard (expands all elements)
   * - `$["complex-key"]` or `$['complex-key']` - Bracket notation for keys with special characters
   *
   * Properties resolved to `undefined` are treated as absent. In particular,
   * `{ path: "$.field", exists: true }` does not match when `field` is present
   * but `undefined`.
   *
   * @example
   * ```typescript
   * { path: "$.eventType", exact: "user.created" }
   * { path: "$.user.age", gte: 18 }
   * { path: "$.items[0].name", match: /^test-/ }
   * { path: "$.tags[*]", exact: "premium" }
   * { path: '$["event-name"]', exists: true }
   * ```
   */
  // biome-ignore lint/suspicious/noExplicitAny: path must be start with `$` and select any property.
  path: `$${string}${any}`;
} & (
  | {
      exact: JSONPrimitive;
      match?: never;
      exists?: never;
      lte?: never;
      gte?: never;
      lt?: never;
      gt?: never;
    }
  | {
      exact?: never;
      match: RegExp;
      exists?: never;
      lte?: never;
      gte?: never;
      lt?: never;
      gt?: never;
    }
  | {
      exact?: never;
      match?: never;
      exists: true;
      lte?: never;
      gte?: never;
      lt?: never;
      gt?: never;
    }
  | {
      exact?: never;
      match?: never;
      exists?: never;
      lte: number;
      gte?: never;
      lt?: never;
      gt?: never;
    }
  | {
      exact?: never;
      match?: never;
      exists?: never;
      lte?: never;
      gte: number;
      lt?: never;
      gt?: never;
    }
  | {
      exact?: never;
      match?: never;
      exists?: never;
      lte?: never;
      gte?: never;
      lt: number;
      gt?: never;
    }
  | {
      exact?: never;
      match?: never;
      exists?: never;
      lte?: never;
      gte?: never;
      lt?: never;
      gt: number;
    }
);

export type LogicalOperator =
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

export type Condition = Comparator | LogicalOperator;

export type Route<Env extends object> = {
  condition: Condition;
  destination: Destinations<Env>;
};

export type Config<Env extends object> = {
  routes: Route<Env>[];
};

type PathCache = Map<string, readonly Token[]>;

const immediate = <T>(f: () => T) => f();

const isQueue = (value: unknown): value is Queue<JSONObject> =>
  typeof value === "object" && value !== null && "sendBatch" in value;
const isR2Bucket = (value: unknown): value is R2Bucket =>
  typeof value === "object" &&
  value !== null &&
  "put" in value &&
  "createMultipartUpload" in value;

const queryWithOptionalCache = (
  message: unknown,
  path: string,
  pathCache?: PathCache,
) => {
  if (!pathCache) {
    return query(message, path);
  }

  let parsed = pathCache.get(path);
  if (!parsed) {
    parsed = parsePath(path);
    pathCache.set(path, parsed);
  }
  return queryWithParsedPath(message, parsed);
};

const match = (message: unknown, cond: Comparator, pathCache?: PathCache) => {
  const values = immediate(() => {
    try {
      return queryWithOptionalCache(message, cond.path, pathCache);
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
  } else if (cond.match !== undefined) {
    const pattern = cond.match;
    match = (v: unknown) => typeof v === "string" && pattern.test(v);
  } else if (cond.exists !== undefined) {
    match = () => true;
  } else if (cond.lte !== undefined) {
    match = (v: unknown) => typeof v === "number" && v <= cond.lte;
  } else if (cond.gte !== undefined) {
    match = (v: unknown) => typeof v === "number" && v >= cond.gte;
  } else if (cond.lt !== undefined) {
    match = (v: unknown) => typeof v === "number" && v < cond.lt;
  } else if (cond.gt !== undefined) {
    match = (v: unknown) => typeof v === "number" && v > cond.gt;
  }

  return values.some(match);
};

const matchCond =
  (message: unknown, pathCache?: PathCache) =>
  (cond: Condition): boolean => {
    if ("path" in cond) {
      return match(message, cond, pathCache);
    }
    if (cond.not !== undefined) {
      return !matchCond(message, pathCache)(cond.not);
    }
    if (cond.allOf !== undefined) {
      return cond.allOf.every(matchCond(message, pathCache));
    }
    return cond.anyOf.some(matchCond(message, pathCache));
  };

export const findRoutes = <Env extends object>(
  c: Config<Env>,
  message: JSONObject,
  pathCache?: PathCache,
): FoundRoute<Env>[] => {
  const matcher = matchCond(message, pathCache);

  return c.routes
    .filter((r) => matcher(r.condition))
    .map(({ destination }) => ({
      destination,
    }));
};

const resolveDestinationBinding = <Env extends object>(
  env: Env,
  destination: Destinations<Env>,
  options: RoutingOptions<Env>,
): ResolvedDestination => {
  const binding = (env as Record<PropertyKey, unknown>)[destination];
  if (!binding) {
    throw new Error(`eventhub: ${String(destination)} not set`);
  }
  if (isQueue(binding)) {
    return {
      kind: "queue",
      queue: binding,
    };
  }
  if (isR2Bucket(binding)) {
    const r2Options = (
      options.r2 as
        | Partial<Record<string, { objectKey: R2ObjectKeyFactory }>>
        | undefined
    )?.[String(destination)];
    return {
      kind: "r2",
      bucket: binding,
      ...(r2Options === undefined ? {} : { objectKey: r2Options.objectKey }),
    };
  }
  throw new Error(
    `eventhub: value of ${String(destination)} is not a Queue or R2Bucket`,
  );
};

export const routeByConfig = <Env extends object>(
  env: Env,
  config: Config<Env>,
  options: RoutingOptions<Env> = {},
): RoutingStrategy<Env> => {
  const pathCache: PathCache = new Map();

  return {
    [safe]: true,
    findRoutes: (message: JSONObject) => findRoutes(config, message, pathCache),
    resolveDestination: (destination: Destinations<Env>) =>
      resolveDestinationBinding(env, destination, options),
  };
};

export const routeFunc = <Env extends object>(
  env: Env,
  fn: (message: JSONObject) => FoundRoute<Env>[],
  options: RoutingOptions<Env> = {},
): RoutingStrategy<Env> => ({
  [safe]: true,
  findRoutes: fn,
  resolveDestination: (destination: Destinations<Env>) =>
    resolveDestinationBinding(env, destination, options),
});
