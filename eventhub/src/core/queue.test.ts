import { describe, expect, test, vi } from "vitest";

import {
	assertQueuesExist,
	deliverJobs,
	deliverPersistedJobs,
	resolveDeliveryJobs,
} from "./queue";
import type { Config } from "./routing";
import { createPendingDeliveryJobs, type PersistedDeliveryJob } from "./store";
import type { EventPayload } from "./type";

class QueueMock implements Queue<EventPayload> {
	readonly sentBatches: MessageSendRequest<EventPayload>[][] = [];
	private readonly failingBatchIndexes: Set<number>;

	constructor(failingBatchIndexes: number[] = []) {
		this.failingBatchIndexes = new Set(failingBatchIndexes);
	}

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
		const batch = Array.from(messages);
		const batchIndex = this.sentBatches.length;
		this.sentBatches.push(batch);
		if (this.failingBatchIndexes.has(batchIndex)) {
			throw new Error(`failed batch ${batchIndex}`);
		}
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

const noopOnDelivered = async (): Promise<void> => {};
const noopOnFailed = async (): Promise<void> => {};

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
		// 1. Build a routed job plan with a missing queue binding.
		// 2. Confirm validation fails before delivery starts.
		const env = {
			OKAYAMA: new QueueMock(),
			HOKKAIDO: new QueueMock(),
		};
		const pendingDeliveryJobs = createPendingDeliveryJobs(routeConfig, [
			{ kind: "nature", avoidUrban: false },
		]);

		expect(() => assertQueuesExist(env, pendingDeliveryJobs)).toThrow(
			/eventhub: OKINAWA not set/,
		);
	});
});

describe("resolveDeliveryJobs", () => {
	test("resolves queues before sending", () => {
		const env = createEnv();
		const payload = { kind: "nature", avoidUrban: false } as const;
		const jobs: PersistedDeliveryJob[] = [
			{
				id: "01TEST00000000000000000001",
				payloadId: "01TEST00000000000000000000",
				destination: "HOKKAIDO",
				payload,
			},
			{
				id: "01TEST00000000000000000002",
				payloadId: "01TEST00000000000000000000",
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
		// 1. Resolve jobs into queue-backed delivery jobs.
		// 2. Send them and verify each destination received the right payload.
		const env = createEnv();
		const payload1 = { kind: "culture", avoidUrban: true };
		const payload2 = { kind: "nature", avoidUrban: false };
		const jobs = resolveDeliveryJobs(env, [
			{
				id: "01TEST00000000000000000001",
				payloadId: "01TEST00000000000000000000",
				destination: "OKAYAMA",
				payload: payload1,
			},
			{
				id: "01TEST00000000000000000003",
				payloadId: "01TEST00000000000000000002",
				destination: "HOKKAIDO",
				payload: payload2,
			},
			{
				id: "01TEST00000000000000000004",
				payloadId: "01TEST00000000000000000002",
				destination: "OKINAWA",
				payload: payload2,
			},
		]);

		await deliverJobs(jobs, {
			onDelivered: noopOnDelivered,
			onFailed: noopOnFailed,
		});

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
				id: `01TEST0000000000000000${String(i + 1).padStart(4, "0")}`,
				payloadId: `01PAYL000000000000000${String(i + 1).padStart(4, "0")}`,
				destination: "OKAYAMA",
				payload: {
					kind: "culture",
					index: i,
				} satisfies EventPayload,
			})),
		);

		await deliverJobs(jobs, {
			onDelivered: noopOnDelivered,
			onFailed: noopOnFailed,
		});

		expect(env.OKAYAMA.sentBatches).toHaveLength(2);
		expect(env.OKAYAMA.sentBatches[0]).toHaveLength(100);
		expect(env.OKAYAMA.sentBatches[1]).toHaveLength(1);
		expect(env.HOKKAIDO.sentBatches).toHaveLength(0);
		expect(env.OKINAWA.sentBatches).toHaveLength(0);
	});

	test("does not send anything when any destination queue is missing", () => {
		// 1. Try to resolve jobs with a missing queue binding.
		// 2. Verify no queue receives any messages.
		const env = {
			OKAYAMA: new QueueMock(),
			HOKKAIDO: new QueueMock(),
		};
		const jobs = [
			{
				id: "01TEST00000000000000000001",
				payloadId: "01TEST00000000000000000000",
				destination: "OKINAWA",
				payload: { kind: "nature", avoidUrban: false } as EventPayload,
			},
		] satisfies PersistedDeliveryJob[];

		expect(() => resolveDeliveryJobs(env, jobs)).toThrow(
			/eventhub: OKINAWA not set/,
		);
		expect(env.HOKKAIDO.sentBatches).toHaveLength(0);
		expect(env.OKAYAMA.sentBatches).toHaveLength(0);
	});

	test("reports delivered job ids after each successful batch", async () => {
		// 1. Deliver enough jobs to produce two batches.
		// 2. Verify the success callback is invoked once per batch with the delivered job IDs.
		const env = createEnv();
		const jobs = resolveDeliveryJobs(
			env,
			Array.from({ length: 101 }, (_, i) => ({
				id: `01TEST0000000000000001${String(i + 1).padStart(4, "0")}`,
				payloadId: `01PAYL0000000000000001${String(i + 1).padStart(4, "0")}`,
				destination: "OKAYAMA",
				payload: {
					kind: "culture",
					index: i,
				} satisfies EventPayload,
			})),
		);
		const delivered: string[][] = [];

		await deliverJobs(jobs, {
			onDelivered: async (jobIds) => {
				delivered.push([...jobIds]);
			},
			onFailed: noopOnFailed,
		});

		expect(delivered).toHaveLength(2);
		expect(delivered[0]).toHaveLength(100);
		expect(delivered[1]).toStrictEqual(["01TEST00000000000000010101"]);
	});

	test("reports failed job ids and continues with other destinations", async () => {
		// 1. Make one destination fail while keeping another healthy.
		// 2. Verify failure reporting does not block delivery to other destinations.
		const env = {
			OKAYAMA: new QueueMock([0]),
			HOKKAIDO: new QueueMock(),
			OKINAWA: new QueueMock(),
		};
		const onDelivered = vi.fn();
		const onFailed = vi.fn();
		const jobs = resolveDeliveryJobs(env, [
			{
				id: "01TEST00000000000000000001",
				payloadId: "01TEST00000000000000000000",
				destination: "OKAYAMA",
				payload: { kind: "culture", avoidUrban: true } as EventPayload,
			},
			{
				id: "01TEST00000000000000000002",
				payloadId: "01TEST00000000000000000000",
				destination: "HOKKAIDO",
				payload: { kind: "nature", avoidUrban: false } as EventPayload,
			},
		]);

		await deliverJobs(jobs, { onDelivered, onFailed });

		expect(onFailed).toHaveBeenCalledTimes(1);
		expect(onFailed.mock.calls[0]?.[0]).toStrictEqual([
			"01TEST00000000000000000001",
		]);
		expect(onDelivered).toHaveBeenCalledTimes(1);
		expect(onDelivered.mock.calls[0]?.[0]).toStrictEqual([
			"01TEST00000000000000000002",
		]);
	});
});

describe("deliverPersistedJobs", () => {
	test("continues delivering other destinations when one destination queue is missing", async () => {
		// 1. Deliver persisted jobs with one unresolved destination.
		// 2. Verify the remaining destination still succeeds.
		const env = {
			HOKKAIDO: new QueueMock(),
			// OKINAWA is missing
		};
		const onDelivered = vi.fn();
		const onFailed = vi.fn();

		await deliverPersistedJobs(
			env,
			[
				{
					id: "01TEST00000000000000000001",
					payloadId: "01TEST00000000000000000000",
					destination: "OKINAWA",
					payload: { kind: "nature", avoidUrban: false } as EventPayload,
				},
				{
					id: "01TEST00000000000000000002",
					payloadId: "01TEST00000000000000000000",
					destination: "HOKKAIDO",
					payload: { kind: "nature", avoidUrban: false } as EventPayload,
				},
			],
			{ onDelivered, onFailed },
		);

		expect(onFailed).toHaveBeenCalledTimes(1);
		expect(onFailed.mock.calls[0]?.[0]).toStrictEqual([
			"01TEST00000000000000000001",
		]);
		expect(onDelivered).toHaveBeenCalledTimes(1);
		expect(onDelivered.mock.calls[0]?.[0]).toStrictEqual([
			"01TEST00000000000000000002",
		]);
		expect(env.HOKKAIDO.sentBatches).toStrictEqual([
			[
				{
					body: { kind: "nature", avoidUrban: false },
					contentType: "json",
				},
			],
		]);
	});
});
