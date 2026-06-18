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

export type Token =
  | { type: "root" }
  | { type: "property"; name: string }
  | { type: "index"; value: number }
  | { type: "wildcard" };

const isControlCharacter = (char: string) => {
  const code = char.codePointAt(0);
  return code !== undefined && code <= 0x1f;
};

const parseEscapeSequence = (path: string, i: number) => {
  const char = path[i];
  if (char === undefined) {
    throw new Error("Unclosed bracket notation");
  }

  switch (char) {
    case '"':
    case "'":
    case "\\":
    case "/":
      return { value: char, nextIndex: i + 1 };
    case "b":
      return { value: "\b", nextIndex: i + 1 };
    case "f":
      return { value: "\f", nextIndex: i + 1 };
    case "n":
      return { value: "\n", nextIndex: i + 1 };
    case "r":
      return { value: "\r", nextIndex: i + 1 };
    case "t":
      return { value: "\t", nextIndex: i + 1 };
    case "u": {
      const hex = path.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new Error(
          `Invalid path syntax at position ${i - 1}: invalid unicode escape`,
        );
      }
      return {
        value: String.fromCharCode(Number.parseInt(hex, 16)),
        nextIndex: i + 5,
      };
    }
    default:
      throw new Error(
        `Invalid path syntax at position ${i - 1}: invalid escape sequence`,
      );
  }
};

/**
 * Parse a JSONPath-like expression into tokens.
 *
 * @param path - The path expression to parse
 * @returns Array of tokens representing the parsed path
 * @throws {Error} If the path syntax is invalid
 */
export function parsePath(path: string): Token[] {
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
        if (isControlCharacter(c)) {
          throw new Error(
            `Invalid path syntax at position ${i}: unexpected character "${c}"`,
          );
        }
        name += c;
        i++;
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
            i++;
            const { value, nextIndex } = parseEscapeSequence(path, i);
            name += value;
            i = nextIndex;
            continue;
          }
          if (isControlCharacter(path[i])) {
            throw new Error(
              `Invalid path syntax at position ${i}: unexpected character "${path[i]}"`,
            );
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

function queryParsed(obj: unknown, tokens: readonly Token[]): unknown[] {
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
          const record = value as Record<string, unknown>;
          const hasOwn = Object.prototype.hasOwnProperty.call(
            record,
            token.name,
          );
          if (hasOwn) {
            const prop = record[token.name];
            if (prop !== undefined) {
              nextValues.push(prop);
            }
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
          nextValues.push(...value.filter((item) => item !== undefined));
        }
      }
    }

    values = nextValues;
  }

  return values;
}

/**
 * Query a value from an object using a JSONPath-like expression.
 *
 * @param obj - The object to query
 * @param path - The JSONPath-like expression
 * @returns Array of matching values (empty array if no matches)
 *
 * Properties or array elements whose value is `undefined` are treated as
 * absent and are not returned. This matches EventHub's JSON serialization
 * model, where `undefined` does not exist in persisted payloads.
 * @throws {Error} If the path syntax is invalid
 */
export function query(obj: unknown, path: string): unknown[] {
  return queryParsed(obj, parsePath(path));
}

export function queryWithParsedPath(
  obj: unknown,
  tokens: readonly Token[],
): unknown[] {
  return queryParsed(obj, tokens);
}
