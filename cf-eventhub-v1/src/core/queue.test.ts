import { describe, expect, test } from "vitest";

import { createDestinationMessages, publishToQueues } from "./queue";
import type { Config } from "./routing";
import type { EventPayload } from "./type";

class QueueMock implements Queue<EventPayload> {
	readonly sentBatches: MessageSendRequest<EventPayload>[][] = [];

	async metrics(): Promise<QueueMetrics> {
		return {
			backlogBytes: 0,
			backlogCount: 0,
		};
	}

	async send(_message: EventPayload): Promise<QueueSendResponse> {
		throw new Error("not implemented");
	}

	async sendBatch(
		messages: Iterable<MessageSendRequest<EventPayload>>,
	): Promise<QueueSendBatchResponse> {
		this.sentBatches.push(Array.from(messages));
		return {
			metadata: {
				metrics: {
					backlogBytes: 0,
					backlogCount: 0,
				},
			},
		};
	}
}

const createEnv = () => ({
	OKAYAMA: new QueueMock(),
	HOKKAIDO: new QueueMock(),
	OKINAWA: new QueueMock(),
});

const routeConfig: Config = {
	routes: [
		{
			condition: {
				path: "$.kind",
				exact: "culture",
			},
			destination: "OKAYAMA",
		},
		{
			condition: {
				path: "$.kind",
				exact: "nature",
			},
			destination: "HOKKAIDO",
		},
		{
			condition: {
				path: "$.kind",
				exact: "nature",
			},
			destination: "OKINAWA",
		},
	],
};

describe("createDestinationMessages", () => {
	test("groups messages by destination", () => {
		const payloads = [
			{ kind: "culture", avoidUrban: true },
			{ kind: "nature", avoidUrban: false },
			{ kind: "other" },
		] as const;

		expect(
			Array.from(createDestinationMessages(routeConfig, payloads).entries()),
		).toStrictEqual([
			["OKAYAMA", [{ body: payloads[0], contentType: "json" }]],
			["HOKKAIDO", [{ body: payloads[1], contentType: "json" }]],
			["OKINAWA", [{ body: payloads[1], contentType: "json" }]],
		]);
	});
});

describe("publishToQueues", () => {
	test("sends matched payloads to destination queues", async () => {
		const env = createEnv();
		const payloads = [
			{ kind: "culture", avoidUrban: true },
			{ kind: "nature", avoidUrban: false },
			{ kind: "other" },
		] as const;

		await publishToQueues(env, routeConfig, payloads);

		expect(env.OKAYAMA.sentBatches).toStrictEqual([
			[{ body: payloads[0], contentType: "json" }],
		]);
		expect(env.HOKKAIDO.sentBatches).toStrictEqual([
			[{ body: payloads[1], contentType: "json" }],
		]);
		expect(env.OKINAWA.sentBatches).toStrictEqual([
			[{ body: payloads[1], contentType: "json" }],
		]);
	});

	test("splits batches per destination", async () => {
		const env = createEnv();
		const payloads = Array.from(
			{ length: 101 },
			(_, i): EventPayload => ({
				kind: "culture",
				index: i,
			}),
		) as [EventPayload, ...EventPayload[]];

		await publishToQueues(env, routeConfig, payloads);

		expect(env.OKAYAMA.sentBatches).toHaveLength(2);
		expect(env.OKAYAMA.sentBatches[0]).toHaveLength(100);
		expect(env.OKAYAMA.sentBatches[1]).toHaveLength(1);
		expect(env.HOKKAIDO.sentBatches).toHaveLength(0);
		expect(env.OKINAWA.sentBatches).toHaveLength(0);
	});

	test("does not send anything when any destination queue is missing", async () => {
		const env = {
			OKAYAMA: new QueueMock(),
			HOKKAIDO: new QueueMock(),
		};
		const payloads = [{ kind: "nature", avoidUrban: false }] as const;

		await expect(publishToQueues(env, routeConfig, payloads)).rejects.toThrow(
			/cf-eventhub-v1: OKINAWA not set/,
		);
		expect(env.HOKKAIDO.sentBatches).toHaveLength(0);
		expect(env.OKAYAMA.sentBatches).toHaveLength(0);
	});
});
