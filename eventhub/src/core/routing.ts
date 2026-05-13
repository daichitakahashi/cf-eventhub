import * as jsonpath from "jsonpath";

type JSONPrimitive = string | number | boolean | null;

export type Comparator =
	| {
			path: string;
			exact: JSONPrimitive;
	  }
	| {
			path: string;
			match: RegExp;
	  }
	| {
			path: string;
			exists: true;
	  }
	| {
			path: string;
			lte: number;
	  }
	| {
			path: string;
			gte: number;
	  }
	| {
			path: string;
			lt: number;
	  }
	| {
			path: string;
			gt: number;
	  };

export type LogicalOperator =
	| {
			allOf: Condition[];
	  }
	| { anyOf: Condition[] }
	| { not: Condition };

export type Condition = Comparator | LogicalOperator;

export type Route = {
	condition: Condition;
	destination: string;
};

export type Config = {
	routes: Route[];
};

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
	} else if ("exists" in cond) {
		match = () => true;
	} else if ("lte" in cond) {
		match = (v: unknown) => typeof v === "number" && v <= cond.lte;
	} else if ("gte" in cond) {
		match = (v: unknown) => typeof v === "number" && v >= cond.gte;
	} else if ("lt" in cond) {
		match = (v: unknown) => typeof v === "number" && v < cond.lt;
	} else if ("gt" in cond) {
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
};

export const findRoutes = (c: Config, message: unknown): FoundRoute[] => {
	const matcher = matchCond(message);

	return c.routes
		.filter((r) => matcher(r.condition))
		.map(({ destination }) => ({
			destination,
		}));
};
