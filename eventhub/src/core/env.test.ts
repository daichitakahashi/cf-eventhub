import { describe, expect, test } from "vitest";

import { parsePositiveInteger } from "./env";

describe("parsePositiveInteger", () => {
	test("returns fallback when value is undefined", () => {
		expect(parsePositiveInteger(undefined, 50, "TEST_VALUE")).toBe(50);
	});

	test("accepts positive integer strings", () => {
		expect(parsePositiveInteger("10", 50, "TEST_VALUE")).toBe(10);
	});

	test("accepts positive integer numbers", () => {
		expect(parsePositiveInteger(10, 50, "TEST_VALUE")).toBe(10);
	});

	test("rejects partially numeric strings", () => {
		expect(() => parsePositiveInteger("10ms", 50, "TEST_VALUE")).toThrow(
			/eventhub: invalid TEST_VALUE/,
		);
	});

	test("rejects decimal strings", () => {
		expect(() => parsePositiveInteger("1.5", 50, "TEST_VALUE")).toThrow(
			/eventhub: invalid TEST_VALUE/,
		);
	});

	test("rejects non-positive values", () => {
		expect(() => parsePositiveInteger("0", 50, "TEST_VALUE")).toThrow(
			/eventhub: invalid TEST_VALUE/,
		);
		expect(() => parsePositiveInteger(-1, 50, "TEST_VALUE")).toThrow(
			/eventhub: invalid TEST_VALUE/,
		);
	});
});
