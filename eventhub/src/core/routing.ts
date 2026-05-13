import * as jsonpath from "jsonpath";

type JSONPrimitive = string | number | boolean | null;

type Comparator =
	| {
			path: string;
			exact: JSONPrimitive;
			match?: never;
			exists?: never;
			lte?: never;
			gte?: never;
			lt?: never;
			gt?: never;
	  }
	| {
			path: string;
			exact?: never;
			match: RegExp;
			exists?: never;
			lte?: never;
			gte?: never;
			lt?: never;
			gt?: never;
	  }
	| {
			path: string;
			exact?: never;
			match?: never;
			exists: true;
			lte?: never;
			gte?: never;
			lt?: never;
			gt?: never;
	  }
	| {
			path: string;
			exact?: never;
			match?: never;
			exists?: never;
			lte: number;
			gte?: never;
			lt?: never;
			gt?: never;
	  }
	| {
			path: string;
			exact?: never;
			match?: never;
			exists?: never;
			lte?: never;
			gte: number;
			lt?: never;
			gt?: never;
	  }
	| {
			path: string;
			exact?: never;
			match?: never;
			exists?: never;
			lte?: never;
			gte?: never;
			lt: number;
			gt?: never;
	  }
	| {
			path: string;
			exact?: never;
			match?: never;
			exists?: never;
			lte?: never;
			gte?: never;
			lt?: never;
			gt: number;
	  };

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
