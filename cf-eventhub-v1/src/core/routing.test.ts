import * as v from "valibot";
import { describe, expect, test } from "vitest";

import { Config, type ConfigInput, findRoutes } from "./routing";

describe("findRoutes", () => {
	test("returns destination for exact comparator", () => {
		const config = v.parse(Config, {
			routes: [
				{
					condition: {
						path: "$.eventName",
						exact: "orderPlaced",
					},
					destination: "ORDER_HANDLER",
				},
			],
		} satisfies ConfigInput);

		expect(findRoutes(config, { eventName: "orderPlaced" })).toStrictEqual([
			{ destination: "ORDER_HANDLER" },
		]);
	});

	test("returns destination for match comparator", () => {
		const config = v.parse(Config, {
			routes: [
				{
					condition: {
						path: "$.eventName",
						match: "^order.*",
					},
					destination: "ORDER_HANDLER",
				},
			],
		} satisfies ConfigInput);

		expect(findRoutes(config, { eventName: "orderPlaced" })).toStrictEqual([
			{ destination: "ORDER_HANDLER" },
		]);
	});

	test("returns destination for exists comparator", () => {
		const config = v.parse(Config, {
			routes: [
				{
					condition: {
						path: "$.orderId",
						exists: true,
					},
					destination: "ORDER_HANDLER",
				},
			],
		} satisfies ConfigInput);

		expect(findRoutes(config, { orderId: null })).toStrictEqual([
			{ destination: "ORDER_HANDLER" },
		]);
	});

	test("evaluates numeric comparators", () => {
		const config = v.parse(Config, {
			routes: [
				{
					condition: {
						path: "$.value",
						lte: 100,
					},
					destination: "LTE",
				},
				{
					condition: {
						path: "$.value",
						gte: 100,
					},
					destination: "GTE",
				},
				{
					condition: {
						path: "$.value",
						lt: 100,
					},
					destination: "LT",
				},
				{
					condition: {
						path: "$.value",
						gt: 100,
					},
					destination: "GT",
				},
			],
		} satisfies ConfigInput);

		expect(findRoutes(config, { value: 99 })).toStrictEqual([
			{ destination: "LTE" },
			{ destination: "LT" },
		]);
		expect(findRoutes(config, { value: 100 })).toStrictEqual([
			{ destination: "LTE" },
			{ destination: "GTE" },
		]);
		expect(findRoutes(config, { value: 101 })).toStrictEqual([
			{ destination: "GTE" },
			{ destination: "GT" },
		]);
	});

	test("evaluates logical operators", () => {
		const config = v.parse(Config, {
			routes: [
				{
					condition: {
						allOf: [
							{ path: "$.kind", exact: "culture" },
							{ path: "$.avoidUrban", exact: false },
						],
					},
					destination: "TOKYO",
				},
				{
					condition: {
						anyOf: [
							{ path: "$.kind", exact: "culture" },
							{ path: "$.kind", exact: "nature" },
						],
					},
					destination: "JAPAN",
				},
				{
					condition: {
						not: { path: "$.disabled", exact: true },
					},
					destination: "ACTIVE_ONLY",
				},
			],
		} satisfies ConfigInput);

		expect(
			findRoutes(config, {
				kind: "culture",
				avoidUrban: false,
				disabled: false,
			}),
		).toStrictEqual([
			{ destination: "TOKYO" },
			{ destination: "JAPAN" },
			{ destination: "ACTIVE_ONLY" },
		]);
	});
});
