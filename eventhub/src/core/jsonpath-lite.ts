/**
 * JSONPath-like path query implementation.
 *
 * This is a lightweight implementation that supports basic value extraction
 * from JSON objects using path expressions. It is NOT a full JSONPath
 * specification implementation.
 *
 * Supported syntax:
 * - `$` - Root reference (required prefix)
 * - `.name` - Property access (e.g., `$.eventName`)
 * - `.nested.path` - Nested property access (e.g., `$.user.address.city`)
 * - `[0]` - Array index access (e.g., `$.items[0]`)
 * - `[*]` - Wildcard array iteration (e.g., `$.items[*]` or `$.items[*].name`)
 * - `["key"]` or `['key']` - Bracket notation for complex keys (e.g., `$["event-name"]`)
 *
 * @example
 * ```typescript
 * query({ name: "Alice" }, "$.name")  // ["Alice"]
 * query({ user: { name: "Bob" } }, "$.user.name")  // ["Bob"]
 * query({ items: [1, 2, 3] }, "$.items[0]")  // [1]
 * query({ items: [1, 2, 3] }, "$.items[*]")  // [1, 2, 3]
 * query({ items: [{name: "a"}, {name: "b"}] }, "$.items[*].name")  // ["a", "b"]
 * query({ "event-name": "test" }, '$["event-name"]')  // ["test"]
 * ```
 */

/**
 * Type representing valid JSONPath-like path expressions.
 *
 * This type validates that path expressions start with `$` at compile time.
 * It provides basic syntax checking but does not validate the full grammar
 * due to TypeScript's type system limitations with recursive patterns.
 *
 * The type ensures:
 * - Path must start with `$`
 * - Common patterns are autocomplete-friendly
 *
 * Accepted patterns:
 * - `$` - Root only
 * - `$.property` - Simple property access
 * - `$.nested.path` - Nested properties (any depth)
 * - `$.array[0]` - Array index access
 * - `$.array[*]` - Array wildcard
 * - `$["complex-key"]` or `$['complex-key']` - Bracket notation
 * - Any combination: `$.items[*].name`, `$.data[0].value`, etc.
 *
 * @example
 * ```typescript
 * const path1: JSONPathLike = "$.name";           // ✓ Valid
 * const path2: JSONPathLike = "$.user.address";   // ✓ Valid
 * const path3: JSONPathLike = "$.items[0]";       // ✓ Valid
 * const path4: JSONPathLike = "$.items[*].name";  // ✓ Valid
 * const path5: JSONPathLike = '$["event-name"]';  // ✓ Valid
 * const path6: JSONPathLike = "name";             // ✗ Type error: missing $
 * ```
 */

type Token =
	| { type: "root" }
	| { type: "property"; name: string }
	| { type: "index"; value: number }
	| { type: "wildcard" };

/**
 * Parse a JSONPath-like expression into tokens.
 *
 * @param path - The path expression to parse
 * @returns Array of tokens representing the parsed path
 * @throws {Error} If the path syntax is invalid
 */
function parsePath(path: string): Token[] {
	if (!path.startsWith("$")) {
		throw new Error("Path must start with $");
	}

	const tokens: Token[] = [{ type: "root" }];
	let i = 1;

	while (i < path.length) {
		const char = path[i];

		if (char === ".") {
			// Property access: .name
			i++;
			let name = "";
			while (i < path.length && path[i] !== "." && path[i] !== "[") {
				const c = path[i];
				// Only allow alphanumeric, underscore, hyphen for property names
				if (
					(c >= "a" && c <= "z") ||
					(c >= "A" && c <= "Z") ||
					(c >= "0" && c <= "9") ||
					c === "_" ||
					c === "-"
				) {
					name += c;
					i++;
				} else {
					throw new Error(
						`Invalid path syntax at position ${i}: unexpected character "${c}"`,
					);
				}
			}
			if (name === "") {
				throw new Error(
					`Invalid path syntax at position ${i}: empty property name`,
				);
			}
			tokens.push({ type: "property", name });
		} else if (char === "[") {
			// Bracket notation: [0], [*], ["key"], or ['key']
			i++;
			if (i >= path.length) {
				throw new Error("Unclosed bracket notation");
			}

			if (path[i] === "*") {
				// Wildcard: [*]
				tokens.push({ type: "wildcard" });
				i++;
				if (i >= path.length || path[i] !== "]") {
					throw new Error(`Invalid path syntax at position ${i}: expected ]`);
				}
				i++;
			} else if (path[i] === '"' || path[i] === "'") {
				// Bracket notation with quotes: ["key"] or ['key']
				const quote = path[i];
				i++;
				let name = "";
				while (i < path.length && path[i] !== quote) {
					if (path[i] === "\\") {
						// Handle escaped quotes
						i++;
						if (i >= path.length) {
							throw new Error("Unclosed bracket notation");
						}
					}
					name += path[i];
					i++;
				}
				if (i >= path.length) {
					throw new Error("Unclosed bracket notation");
				}
				i++; // Skip closing quote
				if (i >= path.length || path[i] !== "]") {
					throw new Error(`Invalid path syntax at position ${i}: expected ]`);
				}
				tokens.push({ type: "property", name });
				i++;
			} else {
				// Array index: [0]
				let indexStr = "";
				while (i < path.length && path[i] !== "]") {
					indexStr += path[i];
					i++;
				}
				if (i >= path.length) {
					throw new Error("Unclosed bracket notation");
				}
				// Validate that indexStr contains only digits
				if (!/^\d+$/.test(indexStr)) {
					throw new Error(
						`Invalid path syntax at position ${i - indexStr.length}: invalid array index "${indexStr}"`,
					);
				}
				const index = Number.parseInt(indexStr, 10);
				tokens.push({ type: "index", value: index });
				i++;
			}
		} else {
			throw new Error(
				`Invalid path syntax at position ${i}: unexpected character "${char}"`,
			);
		}
	}

	return tokens;
}

/**
 * Query a value from an object using a JSONPath-like expression.
 *
 * @param obj - The object to query
 * @param path - The JSONPath-like expression
 * @returns Array of matching values (empty array if no matches)
 * @throws {Error} If the path syntax is invalid
 */
export function query(obj: unknown, path: string): unknown[] {
	const tokens = parsePath(path);

	// Start with the root object
	let values: unknown[] = [obj];

	// Process each token after the root
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		const nextValues: unknown[] = [];

		for (const value of values) {
			if (value === null || value === undefined) {
				continue;
			}

			if (token.type === "property") {
				if (typeof value === "object" && !Array.isArray(value)) {
					const prop = (value as Record<string, unknown>)[token.name];
					if (prop !== undefined) {
						nextValues.push(prop);
					}
				}
			} else if (token.type === "index") {
				if (Array.isArray(value)) {
					const item = value[token.value];
					if (item !== undefined) {
						nextValues.push(item);
					}
				}
			} else if (token.type === "wildcard") {
				if (Array.isArray(value)) {
					nextValues.push(...value);
				}
			}
		}

		values = nextValues;
	}

	return values;
}
