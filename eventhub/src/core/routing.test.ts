import { describe, expect, test } from "vitest";

import { type Config, findRoutes } from "./routing";

describe("findRoutes", () => {
	test("returns destination for exact comparator", () => {
		const config: Config<{ ORDER_HANDLER: Queue }> = {
			routes: [
				{
					condition: {
						path: "$.eventName",
						exact: "orderPlaced",
					},
					destination: "ORDER_HANDLER",
				},
			],
		};

		expect(findRoutes(config, { eventName: "orderPlaced" })).toStrictEqual([
			{ destination: "ORDER_HANDLER" },
		]);
	});

	test("returns destination for match comparator", () => {
		const config: Config<{ ORDER_HANDLER: Queue }> = {
			routes: [
				{
					condition: {
						path: "$.eventName",
						match: /^order.*/,
					},
					destination: "ORDER_HANDLER",
				},
			],
		};

		expect(findRoutes(config, { eventName: "orderPlaced" })).toStrictEqual([
			{ destination: "ORDER_HANDLER" },
		]);
	});

	test("returns destination for exists comparator", () => {
		const config: Config<{ ORDER_HANDLER: Queue }> = {
			routes: [
				{
					condition: {
						path: "$.orderId",
						exists: true,
					},
					destination: "ORDER_HANDLER",
				},
			],
		};

		expect(findRoutes(config, { orderId: null })).toStrictEqual([
			{ destination: "ORDER_HANDLER" },
		]);
	});

	test("treats undefined properties as absent for exists comparator", () => {
		const config: Config<{ ORDER_HANDLER: Queue }> = {
			routes: [
				{
					condition: {
						path: "$.orderId",
						exists: true,
					},
					destination: "ORDER_HANDLER",
				},
			],
		};

		expect(findRoutes(config, { orderId: undefined })).toStrictEqual([]);
	});

	test("evaluates numeric comparators", () => {
		const config: Config<{
			LTE: Queue;
			GTE: Queue;
			LT: Queue;
			GT: Queue;
		}> = {
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
		};

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

	test("evaluates zero-valued numeric comparators", () => {
		const config: Config<{
			LTE_ZERO: Queue;
			GTE_ZERO: Queue;
			LT_ZERO: Queue;
			GT_ZERO: Queue;
		}> = {
			routes: [
				{
					condition: {
						path: "$.value",
						lte: 0,
					},
					destination: "LTE_ZERO",
				},
				{
					condition: {
						path: "$.value",
						gte: 0,
					},
					destination: "GTE_ZERO",
				},
				{
					condition: {
						path: "$.value",
						lt: 0,
					},
					destination: "LT_ZERO",
				},
				{
					condition: {
						path: "$.value",
						gt: 0,
					},
					destination: "GT_ZERO",
				},
			],
		};

		expect(findRoutes(config, { value: -1 })).toStrictEqual([
			{ destination: "LTE_ZERO" },
			{ destination: "LT_ZERO" },
		]);
		expect(findRoutes(config, { value: 0 })).toStrictEqual([
			{ destination: "LTE_ZERO" },
			{ destination: "GTE_ZERO" },
		]);
		expect(findRoutes(config, { value: 1 })).toStrictEqual([
			{ destination: "GTE_ZERO" },
			{ destination: "GT_ZERO" },
		]);
	});

	test("evaluates logical operators", () => {
		const config: Config<{
			TOKYO: Queue;
			JAPAN: Queue;
			ACTIVE_ONLY: Queue;
		}> = {
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
		};

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
