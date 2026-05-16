import { query } from "./jsonpath-lite";
import type { JSONObject } from "./type";

type Destination = Queue | R2Bucket;

type Destinations<Env extends Record<string, unknown>> = keyof {
	[K in keyof Env as K extends string
		? Env[K] extends Destination
			? K
			: never
		: never]: Env[K];
};

const safe: unique symbol = Symbol();

export interface RoutingStrategy<Env extends Record<string, unknown>> {
	[safe]: true;
	findRoutes(message: JSONObject): FoundRoute<Env>[];
}

type FoundRoute<Env extends Record<string, unknown>> = {
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
	// biome-ignore lint/suspicious/noExplicitAny: property name must be a non-empty string
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

export type Route<Env extends Record<string, unknown>> = {
	condition: Condition;
	destination: Destinations<Env>;
};

export type Config<Env extends Record<string, unknown>> = {
	routes: Route<Env>[];
};

const immediate = <T>(f: () => T) => f();

const match = (message: unknown, cond: Comparator) => {
	const values = immediate(() => {
		try {
			return query(message, cond.path);
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
	(message: unknown) =>
	(cond: Condition): boolean => {
		if ("path" in cond) {
			return match(message, cond);
		}
		if (cond.not !== undefined) {
			return !matchCond(message)(cond.not);
		}
		if (cond.allOf !== undefined) {
			return cond.allOf.every(matchCond(message));
		}
		return cond.anyOf.some(matchCond(message));
	};

export const findRoutes = <Env extends Record<string, unknown>>(
	c: Config<Env>,
	message: JSONObject,
): FoundRoute<Env>[] => {
	const matcher = matchCond(message);

	return c.routes
		.filter((r) => matcher(r.condition))
		.map(({ destination }) => ({
			destination,
		}));
};

export const routeByConfig = <Env extends Record<string, unknown>>(
	config: Config<Env>,
): RoutingStrategy<Env> => ({
	[safe]: true,
	findRoutes: (message: JSONObject) => findRoutes(config, message),
});

export const routeFunc = <Env extends Record<string, unknown>>(
	fn: (message: JSONObject) => FoundRoute<Env>[],
): RoutingStrategy<Env> => ({
	[safe]: true,
	findRoutes: fn,
});
