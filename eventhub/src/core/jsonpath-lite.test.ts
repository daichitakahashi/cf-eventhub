import { describe, expect, test } from "vitest";

import { query } from "./jsonpath-lite";

describe("jsonpath-lite", () => {
	describe("simple property access", () => {
		test("extracts root-level property", () => {
			const obj = { name: "Alice", age: 30 };
			expect(query(obj, "$.name")).toStrictEqual(["Alice"]);
			expect(query(obj, "$.age")).toStrictEqual([30]);
		});

		test("returns empty array for missing property", () => {
			const obj = { name: "Alice" };
			expect(query(obj, "$.missing")).toStrictEqual([]);
		});

		test("handles null and undefined values", () => {
			const obj = { value: null, other: undefined };
			expect(query(obj, "$.value")).toStrictEqual([null]);
			expect(query(obj, "$.other")).toStrictEqual([]);
		});

		test("handles boolean values", () => {
			const obj = { enabled: true, disabled: false };
			expect(query(obj, "$.enabled")).toStrictEqual([true]);
			expect(query(obj, "$.disabled")).toStrictEqual([false]);
		});

		test("handles numeric values including zero", () => {
			const obj = { count: 0, value: 42 };
			expect(query(obj, "$.count")).toStrictEqual([0]);
			expect(query(obj, "$.value")).toStrictEqual([42]);
		});

		test("accepts broader characters in dot notation property names", () => {
			const obj = {
				"event name": "launch",
				"@type": "custom.event",
				"ユーザー": {
					"😀": "ok",
				},
			};

			expect(query(obj, "$.event name")).toStrictEqual(["launch"]);
			expect(query(obj, "$.@type")).toStrictEqual(["custom.event"]);
			expect(query(obj, "$.ユーザー.😀")).toStrictEqual(["ok"]);
		});
	});

	describe("nested property access", () => {
		test("extracts nested property", () => {
			const obj = { user: { name: "Bob", address: { city: "Tokyo" } } };
			expect(query(obj, "$.user.name")).toStrictEqual(["Bob"]);
			expect(query(obj, "$.user.address.city")).toStrictEqual(["Tokyo"]);
		});

		test("returns empty array for missing nested property", () => {
			const obj = { user: { name: "Bob" } };
			expect(query(obj, "$.user.missing")).toStrictEqual([]);
			expect(query(obj, "$.missing.property")).toStrictEqual([]);
		});

		test("handles null in nested path", () => {
			const obj = { user: null };
			expect(query(obj, "$.user.name")).toStrictEqual([]);
		});
	});

	describe("array index access", () => {
		test("extracts specific array element", () => {
			const obj = { items: [1, 2, 3] };
			expect(query(obj, "$.items[0]")).toStrictEqual([1]);
			expect(query(obj, "$.items[1]")).toStrictEqual([2]);
			expect(query(obj, "$.items[2]")).toStrictEqual([3]);
		});

		test("returns empty array for out-of-bounds index", () => {
			const obj = { items: [1, 2, 3] };
			expect(query(obj, "$.items[10]")).toStrictEqual([]);
		});

		test("accesses property after array index", () => {
			const obj = { items: [{ name: "a" }, { name: "b" }] };
			expect(query(obj, "$.items[0].name")).toStrictEqual(["a"]);
			expect(query(obj, "$.items[1].name")).toStrictEqual(["b"]);
		});

		test("handles nested arrays", () => {
			const obj = {
				matrix: [
					[1, 2],
					[3, 4],
				],
			};
			expect(query(obj, "$.matrix[0]")).toStrictEqual([[1, 2]]);
			expect(query(obj, "$.matrix[0][1]")).toStrictEqual([2]);
		});
	});

	describe("wildcard array iteration", () => {
		test("expands all array elements", () => {
			const obj = { items: [1, 2, 3] };
			expect(query(obj, "$.items[*]")).toStrictEqual([1, 2, 3]);
		});

		test("expands array and accesses properties", () => {
			const obj = { items: [{ name: "a" }, { name: "b" }, { name: "c" }] };
			expect(query(obj, "$.items[*].name")).toStrictEqual(["a", "b", "c"]);
		});

		test("returns empty array for non-array value", () => {
			const obj = { value: "not-an-array" };
			expect(query(obj, "$.value[*]")).toStrictEqual([]);
		});

		test("handles wildcard on empty array", () => {
			const obj = { items: [] };
			expect(query(obj, "$.items[*]")).toStrictEqual([]);
		});

		test("handles multiple wildcards", () => {
			const obj = {
				groups: [
					{ items: [{ value: 1 }, { value: 2 }] },
					{ items: [{ value: 3 }, { value: 4 }] },
				],
			};
			expect(query(obj, "$.groups[*].items[*].value")).toStrictEqual([
				1, 2, 3, 4,
			]);
		});

		test("skips null and undefined in wildcard expansion", () => {
			const obj = {
				items: [{ name: "a" }, null, { name: "b" }, undefined, { name: "c" }],
			};
			expect(query(obj, "$.items[*].name")).toStrictEqual(["a", "b", "c"]);
		});
	});

	describe("bracket notation with quotes", () => {
		test('extracts property with double quotes ["key"]', () => {
			const obj = { "event-name": "test", "complex.key": "value" };
			expect(query(obj, '$["event-name"]')).toStrictEqual(["test"]);
			expect(query(obj, '$["complex.key"]')).toStrictEqual(["value"]);
		});

		test("extracts property with single quotes ['key']", () => {
			const obj = { "event-name": "test" };
			expect(query(obj, "$['event-name']")).toStrictEqual(["test"]);
		});

		test("handles special characters in bracket notation", () => {
			const obj = { "key with spaces": "value", "key@with#symbols": "test" };
			expect(query(obj, '$["key with spaces"]')).toStrictEqual(["value"]);
			expect(query(obj, '$["key@with#symbols"]')).toStrictEqual(["test"]);
		});

		test("handles escaped quotes in bracket notation", () => {
			const obj = { 'key"with"quote': "value" };
			expect(query(obj, '$["key\\"with\\"quote"]')).toStrictEqual(["value"]);
		});

		test("handles standard escape sequences in bracket notation", () => {
			const obj = {
				"line\nbreak": "newline",
				"tab\tkey": "tab",
				"slash/key": "slash",
				"back\\slash": "backslash",
				"single'quote": "single",
				"unicode\u{1F600}": "emoji",
			};

			expect(query(obj, '$["line\\nbreak"]')).toStrictEqual(["newline"]);
			expect(query(obj, '$["tab\\tkey"]')).toStrictEqual(["tab"]);
			expect(query(obj, '$["slash\\/key"]')).toStrictEqual(["slash"]);
			expect(query(obj, '$["back\\\\slash"]')).toStrictEqual(["backslash"]);
			expect(query(obj, "$['single\\'quote']")).toStrictEqual(["single"]);
			expect(query(obj, '$["unicode\\uD83D\\uDE00"]')).toStrictEqual(["emoji"]);
		});

		test("can combine bracket notation with other accessors", () => {
			const obj = { "event-name": { nested: { value: 42 } } };
			expect(query(obj, '$["event-name"].nested.value')).toStrictEqual([42]);
		});
	});

	describe("combined patterns", () => {
		test("combines nested paths, arrays, and wildcards", () => {
			const obj = {
				users: [
					{ name: "Alice", orders: [{ id: 1 }, { id: 2 }] },
					{ name: "Bob", orders: [{ id: 3 }] },
				],
			};
			expect(query(obj, "$.users[*].orders[*].id")).toStrictEqual([1, 2, 3]);
		});

		test("handles complex real-world structure", () => {
			const obj = {
				events: [
					{
						type: "order.placed",
						data: { orderId: "A1", items: [{ sku: "X" }, { sku: "Y" }] },
					},
					{
						type: "order.shipped",
						data: { orderId: "A2", items: [{ sku: "Z" }] },
					},
				],
			};
			expect(query(obj, "$.events[*].data.items[*].sku")).toStrictEqual([
				"X",
				"Y",
				"Z",
			]);
		});
	});

	describe("error handling", () => {
		test("throws error when path does not start with $", () => {
			expect(() => query({}, "name")).toThrow("Path must start with $");
			expect(() => query({}, ".name")).toThrow("Path must start with $");
		});

		test("throws error for empty property name", () => {
			expect(() => query({}, "$.")).toThrow("empty property name");
		});

		test("throws error for unclosed bracket", () => {
			expect(() => query({}, "$[0")).toThrow("Unclosed bracket notation");
			expect(() => query({}, '$["name')).toThrow("Unclosed bracket notation");
		});

		test("throws error for invalid array index", () => {
			expect(() => query({}, "$[abc]")).toThrow("invalid array index");
			expect(() => query({}, "$[1.5]")).toThrow("invalid array index");
		});

		test("throws error for control characters in dot notation", () => {
			expect(() => query({}, "$.name\n")).toThrow("unexpected character");
		});

		test("throws error for malformed bracket notation", () => {
			expect(() => query({}, "$[*")).toThrow("expected ]");
			expect(() => query({}, '$["key"x]')).toThrow("expected ]");
		});
	});

	describe("edge cases", () => {
		test("handles root object query", () => {
			const obj = { name: "test" };
			expect(query(obj, "$")).toStrictEqual([obj]);
		});

		test("handles non-object root values", () => {
			expect(query("string", "$.prop")).toStrictEqual([]);
			expect(query(42, "$.prop")).toStrictEqual([]);
			expect(query(true, "$.prop")).toStrictEqual([]);
			expect(query(null, "$.prop")).toStrictEqual([]);
		});

		test("handles array as root with index", () => {
			const arr = [1, 2, 3];
			expect(query(arr, "$[0]")).toStrictEqual([1]);
		});

		test("handles array as root with wildcard", () => {
			const arr = [1, 2, 3];
			expect(query(arr, "$[*]")).toStrictEqual([1, 2, 3]);
		});

		test("handles deeply nested structures", () => {
			const obj = { a: { b: { c: { d: { e: "deep" } } } } };
			expect(query(obj, "$.a.b.c.d.e")).toStrictEqual(["deep"]);
		});

		test("handles objects with numeric string keys", () => {
			const obj = { "123": "value" };
			expect(query(obj, '$["123"]')).toStrictEqual(["value"]);
		});
	});
});
