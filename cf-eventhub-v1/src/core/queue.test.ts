import { describe, expect, test } from "vitest";

import { assertQueuesExist, deliverJobs, resolveDeliveryJobs } from "./queue";
import type { Config } from "./routing";
import {
	createPendingDeliveryJobs,
	type PersistedDeliveryJob,
} from "./store";
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

describe("assertQueuesExist", () => {
	test("fails before persistence when a destination queue is missing", () => {
		const env = {
			OKAYAMA: new QueueMock(),
			HOKKAIDO: new QueueMock(),
		};
		const pendingDeliveryJobs = createPendingDeliveryJobs(routeConfig, [
			{ kind: "nature", avoidUrban: false },
		]);

		expect(() => assertQueuesExist(env, pendingDeliveryJobs)).toThrow(
			/cf-eventhub-v1: OKINAWA not set/,
		);
	});
});

describe("resolveDeliveryJobs", () => {
	test("resolves queues before sending", () => {
		const env = createEnv();
		const payload = { kind: "nature", avoidUrban: false } as const;
		const jobs: PersistedDeliveryJob[] = [
			{
				id: 1,
				payloadId: 1,
				destination: "HOKKAIDO",
				payload,
			},
			{
				id: 2,
				payloadId: 1,
				destination: "OKINAWA",
				payload,
			},
		];

		expect(resolveDeliveryJobs(env, jobs)).toStrictEqual([
			{
				...jobs[0],
				queue: env.HOKKAIDO,
			},
			{
				...jobs[1],
				queue: env.OKINAWA,
			},
		]);
	});
});

describe("deliverJobs", () => {
	test("sends matched payloads to destination queues", async () => {
		const env = createEnv();
		const payload1 = { kind: "culture", avoidUrban: true };
		const payload2 = { kind: "nature", avoidUrban: false };
		const jobs = resolveDeliveryJobs(env, [
			{ id: 1, payloadId: 1, destination: "OKAYAMA", payload: payload1 },
			{ id: 2, payloadId: 2, destination: "HOKKAIDO", payload: payload2 },
			{ id: 3, payloadId: 2, destination: "OKINAWA", payload: payload2 },
		]);

		await deliverJobs(jobs);

		expect(env.OKAYAMA.sentBatches).toStrictEqual([
			[{ body: payload1, contentType: "json" }],
		]);
		expect(env.HOKKAIDO.sentBatches).toStrictEqual([
			[{ body: payload2, contentType: "json" }],
		]);
		expect(env.OKINAWA.sentBatches).toStrictEqual([
			[{ body: payload2, contentType: "json" }],
		]);
	});

	test("splits batches per destination", async () => {
		const env = createEnv();
		const jobs = resolveDeliveryJobs(
			env,
			Array.from({ length: 101 }, (_, i) => ({
				id: i + 1,
				payloadId: i + 1,
				destination: "OKAYAMA",
				payload: {
					kind: "culture",
					index: i,
				} satisfies EventPayload,
			})),
		);

		await deliverJobs(jobs);

		expect(env.OKAYAMA.sentBatches).toHaveLength(2);
		expect(env.OKAYAMA.sentBatches[0]).toHaveLength(100);
		expect(env.OKAYAMA.sentBatches[1]).toHaveLength(1);
		expect(env.HOKKAIDO.sentBatches).toHaveLength(0);
		expect(env.OKINAWA.sentBatches).toHaveLength(0);
	});

	test("does not send anything when any destination queue is missing", () => {
		const env = {
			OKAYAMA: new QueueMock(),
			HOKKAIDO: new QueueMock(),
		};
		const jobs = [
			{
				id: 1,
				payloadId: 1,
				destination: "OKINAWA",
				payload: { kind: "nature", avoidUrban: false } as EventPayload,
			},
		] satisfies PersistedDeliveryJob[];

		expect(() => resolveDeliveryJobs(env, jobs)).toThrow(
			/cf-eventhub-v1: OKINAWA not set/,
		);
		expect(env.HOKKAIDO.sentBatches).toHaveLength(0);
		expect(env.OKAYAMA.sentBatches).toHaveLength(0);
	});

	test("reports delivered job ids after each successful batch", async () => {
		const env = createEnv();
		const jobs = resolveDeliveryJobs(
			env,
			Array.from({ length: 101 }, (_, i) => ({
				id: i + 1,
				payloadId: i + 1,
				destination: "OKAYAMA",
				payload: {
					kind: "culture",
					index: i,
				} satisfies EventPayload,
			})),
		);
		const delivered: number[][] = [];

		await deliverJobs(jobs, async (jobIds) => {
			delivered.push([...jobIds]);
		});

		expect(delivered).toHaveLength(2);
		expect(delivered[0]).toHaveLength(100);
		expect(delivered[1]).toStrictEqual([101]);
	});
});
