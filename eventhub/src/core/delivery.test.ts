import { describe, expect, test, vi } from "vitest";

import {
	assertDestinationBindingsExist,
	deliverJobs,
	deliverPersistedJobs,
	resolveDeliveryJobs,
} from "./delivery";
import { routeByConfig } from "./routing";
import { type PersistedDeliveryJob, createPendingDeliveryJobs } from "./store";
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

class R2BucketMock {
	readonly objects = new Map<string, { body: string; contentType?: string }>();
	private readonly failingKeys: Set<string>;

	constructor(failingKeys: string[] = []) {
		this.failingKeys = new Set(failingKeys);
	}

	async head(): Promise<R2Object | null> {
		return null;
	}

	async get(): Promise<R2ObjectBody | null> {
		return null;
	}

	async put(
		key: string,
		value:
			| ReadableStream
			| ArrayBuffer
			| ArrayBufferView
			| string
			| null
			| Blob,
		options?: R2PutOptions,
	): Promise<R2Object> {
		if (this.failingKeys.has(key)) {
			throw new Error(`failed put ${key}`);
		}
		if (typeof value !== "string") {
			throw new Error("expected string payload");
		}
		this.objects.set(key, {
			body: value,
			// @ts-expect-error: assume httpMetadata is always R2HTTPMetadata
			contentType: options?.httpMetadata?.contentType,
		});
		return {
			key,
			version: "v1",
			size: value.length,
			etag: "etag",
			httpEtag: "etag",
			checksums: { toJSON: () => ({}) },
			uploaded: new Date(),
			storageClass: "Standard",
			writeHttpMetadata: () => {},
		} as R2Object;
	}

	async createMultipartUpload(): Promise<R2MultipartUpload> {
		throw new Error("not implemented");
	}

	resumeMultipartUpload(): R2MultipartUpload {
		throw new Error("not implemented");
	}

	async delete(): Promise<void> {}

	async list(): Promise<R2Objects> {
		return {
			objects: [],
			delimitedPrefixes: [],
			truncated: false,
		};
	}
}

const createEnv = () => ({
	OKAYAMA: new QueueMock(),
	HOKKAIDO: new QueueMock(),
	OKINAWA: new QueueMock(),
	ARCHIVE: new R2BucketMock() as unknown as R2Bucket,
});

type Env = ReturnType<typeof createEnv>;

const noopOnDelivered = async (): Promise<void> => {};
const noopOnFailed = async (): Promise<void> => {};

const routing = routeByConfig<Env>({
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
});

describe("assertDestinationBindingsExist", () => {
	test("fails before persistence when a destination binding is missing", () => {
		// 1. Build a routed job plan with a missing binding.
		// 2. Confirm validation fails before delivery starts.
		const env = {
			OKAYAMA: new QueueMock(),
			HOKKAIDO: new QueueMock(),
		};
		const pendingDeliveryJobs = createPendingDeliveryJobs(routing, [
			{ kind: "nature", avoidUrban: false },
		]);

		expect(() =>
			assertDestinationBindingsExist(env, pendingDeliveryJobs),
		).toThrow(/eventhub: OKINAWA not set/);
	});

	test("fails before persistence when a destination binding is neither Queue nor R2", () => {
		const env = {
			ARCHIVE: {},
		};
		const routing = routeByConfig<typeof env>({
			routes: [
				{
					condition: {
						path: "$.kind",
						exact: "archive",
					},
					// @ts-expect-error
					destination: "ARCHIVE",
				},
			],
		});
		const pendingDeliveryJobs = createPendingDeliveryJobs(routing, [
			{ kind: "archive", avoidUrban: false },
		]);

		expect(() =>
			assertDestinationBindingsExist(env, pendingDeliveryJobs),
		).toThrow(/eventhub: value of ARCHIVE is not a Queue or R2Bucket/);
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
				target: {
					kind: "queue",
					queue: env.HOKKAIDO,
				},
			},
			{
				...jobs[1],
				target: {
					kind: "queue",
					queue: env.OKINAWA,
				},
			},
		]);
	});

	test("resolves R2 buckets before sending", () => {
		const env = createEnv();
		const payload = { kind: "archive", avoidUrban: false } as const;
		const jobs: PersistedDeliveryJob[] = [
			{
				id: "01TEST00000000000000000005",
				payloadId: "01TEST00000000000000000004",
				destination: "ARCHIVE",
				payload,
			},
		];

		expect(resolveDeliveryJobs(env, jobs)).toStrictEqual([
			{
				...jobs[0],
				target: {
					kind: "r2",
					bucket: env.ARCHIVE,
				},
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

		await deliverJobs(
			jobs,
			{
				onDelivered: noopOnDelivered,
				onFailed: noopOnFailed,
			},
			false,
		);

		expect(env.OKAYAMA.sentBatches).toStrictEqual([
			[{ body: payload1, contentType: "json" }],
		]);
		expect(env.HOKKAIDO.sentBatches).toStrictEqual([
			[{ body: payload2, contentType: "json" }],
		]);
		expect(env.OKINAWA.sentBatches).toStrictEqual([
			[{ body: payload2, contentType: "json" }],
		]);
		expect((env.ARCHIVE as unknown as R2BucketMock).objects.size).toBe(0);
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

		await deliverJobs(
			jobs,
			{
				onDelivered: noopOnDelivered,
				onFailed: noopOnFailed,
			},
			false,
		);

		expect(env.OKAYAMA.sentBatches.map((batch) => batch.length)).toStrictEqual([
			100, 1,
		]);
		expect(env.HOKKAIDO.sentBatches).toStrictEqual([]);
		expect(env.OKINAWA.sentBatches).toStrictEqual([]);
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

	test("writes matched payloads to destination buckets", async () => {
		const env = createEnv();
		const payload = { kind: "archive", avoidUrban: false };
		const jobs = resolveDeliveryJobs(env, [
			{
				id: "01TEST00000000000000000011",
				payloadId: "01TEST00000000000000000010",
				destination: "ARCHIVE",
				payload,
			},
		]);

		await deliverJobs(
			jobs,
			{
				onDelivered: noopOnDelivered,
				onFailed: noopOnFailed,
			},
			false,
		);

		expect((env.ARCHIVE as unknown as R2BucketMock).objects).toStrictEqual(
			new Map([
				[
					"01TEST00000000000000000010/01TEST00000000000000000011.json",
					{
						body: JSON.stringify(payload),
						contentType: "application/json",
					},
				],
			]),
		);
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

		await deliverJobs(
			jobs,
			{
				onDelivered: async (jobIds) => {
					delivered.push([...jobIds]);
				},
				onFailed: noopOnFailed,
			},
			false,
		);

		expect(delivered).toMatchObject([
			Array.from({ length: 100 }, () => expect.any(String)),
			["01TEST00000000000000010101"],
		]);
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

		await deliverJobs(jobs, { onDelivered, onFailed }, false);

		expect(onFailed).toHaveBeenCalledTimes(1);
		expect(onFailed.mock.calls[0]?.[0]).toStrictEqual([
			"01TEST00000000000000000001",
		]);
		expect(onDelivered).toHaveBeenCalledTimes(1);
		expect(onDelivered.mock.calls[0]?.[0]).toStrictEqual([
			"01TEST00000000000000000002",
		]);
	});

	test("reports failed R2 job ids one by one and continues with queues", async () => {
		const archive = new R2BucketMock([
			"01TEST00000000000000000020/01TEST00000000000000000021.json",
		]);
		const env = {
			OKAYAMA: new QueueMock(),
			HOKKAIDO: new QueueMock(),
			OKINAWA: new QueueMock(),
			ARCHIVE: archive as unknown as R2Bucket,
		};
		const onDelivered = vi.fn();
		const onFailed = vi.fn();
		const jobs = resolveDeliveryJobs(env, [
			{
				id: "01TEST00000000000000000021",
				payloadId: "01TEST00000000000000000020",
				destination: "ARCHIVE",
				payload: { kind: "archive", avoidUrban: false } as EventPayload,
			},
			{
				id: "01TEST00000000000000000022",
				payloadId: "01TEST00000000000000000020",
				destination: "OKAYAMA",
				payload: { kind: "culture", avoidUrban: true } as EventPayload,
			},
		]);

		await deliverJobs(jobs, { onDelivered, onFailed }, false);

		expect(onFailed).toHaveBeenCalledTimes(1);
		expect(onFailed.mock.calls[0]?.[0]).toStrictEqual([
			"01TEST00000000000000000021",
		]);
		expect(onDelivered).toHaveBeenCalledTimes(1);
		expect(onDelivered.mock.calls[0]?.[0]).toStrictEqual([
			"01TEST00000000000000000022",
		]);
	});
});

describe("deliverPersistedJobs", () => {
	test("continues delivering other destinations when one destination binding is missing", async () => {
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
			false,
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

	test("continues delivering other destinations when one R2 bucket write fails", async () => {
		const archive = new R2BucketMock([
			"01TEST00000000000000000030/01TEST00000000000000000031.json",
		]);
		const env = {
			OKAYAMA: new QueueMock(),
			ARCHIVE: archive as unknown as R2Bucket,
		};
		const onDelivered = vi.fn();
		const onFailed = vi.fn();

		await deliverPersistedJobs(
			env,
			[
				{
					id: "01TEST00000000000000000031",
					payloadId: "01TEST00000000000000000030",
					destination: "ARCHIVE",
					payload: { kind: "archive", avoidUrban: false } as EventPayload,
				},
				{
					id: "01TEST00000000000000000032",
					payloadId: "01TEST00000000000000000030",
					destination: "OKAYAMA",
					payload: { kind: "culture", avoidUrban: true } as EventPayload,
				},
			],
			{ onDelivered, onFailed },
			false,
		);

		expect(onFailed).toHaveBeenCalledTimes(1);
		expect(onFailed.mock.calls[0]?.[0]).toStrictEqual([
			"01TEST00000000000000000031",
		]);
		expect(onDelivered).toHaveBeenCalledTimes(1);
		expect(onDelivered.mock.calls[0]?.[0]).toStrictEqual([
			"01TEST00000000000000000032",
		]);
		expect(archive.objects.size).toBe(0);
	});

	test("injects delivery job ID when includeDeliveryJobId is true for Queue", async () => {
		// 1. Deliver jobs to a Queue with includeDeliveryJobId enabled.
		// 2. Verify the sent payloads include __eventhub__.deliveryJobId.
		const env = createEnv();
		const payload = { kind: "culture", avoidUrban: true };
		const jobs = resolveDeliveryJobs(env, [
			{
				id: "01TEST00000000000000000001",
				payloadId: "01TEST00000000000000000000",
				destination: "OKAYAMA",
				payload,
			},
		]);

		await deliverJobs(
			jobs,
			{
				onDelivered: noopOnDelivered,
				onFailed: noopOnFailed,
			},
			true,
		);

		expect(env.OKAYAMA.sentBatches).toStrictEqual([
			[
				{
					body: {
						...payload,
						__eventhub__: { deliveryJobId: "01TEST00000000000000000001" },
					},
					contentType: "json",
				},
			],
		]);
	});

	test("injects delivery job ID when includeDeliveryJobId is true for R2", async () => {
		// 1. Deliver jobs to an R2 bucket with includeDeliveryJobId enabled.
		// 2. Verify the stored payload includes __eventhub__.deliveryJobId.
		const env = createEnv();
		const payload = { kind: "archive", avoidUrban: false };
		const jobs = resolveDeliveryJobs(env, [
			{
				id: "01TEST00000000000000000011",
				payloadId: "01TEST00000000000000000010",
				destination: "ARCHIVE",
				payload,
			},
		]);

		await deliverJobs(
			jobs,
			{
				onDelivered: noopOnDelivered,
				onFailed: noopOnFailed,
			},
			true,
		);

		const archive = env.ARCHIVE as unknown as R2BucketMock;
		const stored = archive.objects.get(
			"01TEST00000000000000000010/01TEST00000000000000000011.json",
		);
		expect(stored).toBeDefined();
		expect(JSON.parse(stored?.body ?? "{}")).toStrictEqual({
			...payload,
			__eventhub__: { deliveryJobId: "01TEST00000000000000000011" },
		});
	});

	test("merges delivery job ID with existing __eventhub__ object", async () => {
		// 1. Deliver a payload that already has an __eventhub__ object.
		// 2. Verify the delivery job ID is merged, preserving existing fields.
		const env = createEnv();
		const payload = {
			kind: "culture",
			__eventhub__: { customField: "value" },
		};
		const jobs = resolveDeliveryJobs(env, [
			{
				id: "01TEST00000000000000000002",
				payloadId: "01TEST00000000000000000000",
				destination: "OKAYAMA",
				payload,
			},
		]);

		await deliverJobs(
			jobs,
			{
				onDelivered: noopOnDelivered,
				onFailed: noopOnFailed,
			},
			true,
		);

		expect(env.OKAYAMA.sentBatches).toStrictEqual([
			[
				{
					body: {
						kind: "culture",
						__eventhub__: {
							customField: "value",
							deliveryJobId: "01TEST00000000000000000002",
						},
					},
					contentType: "json",
				},
			],
		]);
	});

	test("replaces non-object __eventhub__ with delivery job ID", async () => {
		// 1. Deliver a payload with __eventhub__ set to a non-object value.
		// 2. Verify the value is replaced with an object containing the delivery job ID.
		const env = createEnv();
		const payloadWithArray = {
			kind: "culture",
			__eventhub__: ["not", "an", "object"],
		};
		const jobs = resolveDeliveryJobs(env, [
			{
				id: "01TEST00000000000000000003",
				payloadId: "01TEST00000000000000000000",
				destination: "OKAYAMA",
				payload: payloadWithArray,
			},
		]);

		await deliverJobs(
			jobs,
			{
				onDelivered: noopOnDelivered,
				onFailed: noopOnFailed,
			},
			true,
		);

		expect(env.OKAYAMA.sentBatches).toStrictEqual([
			[
				{
					body: {
						kind: "culture",
						__eventhub__: { deliveryJobId: "01TEST00000000000000000003" },
					},
					contentType: "json",
				},
			],
		]);
	});

	test("does not modify original payload when injecting job ID", async () => {
		// 1. Deliver a payload with includeDeliveryJobId enabled.
		// 2. Verify the original payload object is not mutated.
		const env = createEnv();
		const payload = { kind: "culture", avoidUrban: true };
		const payloadCopy = { ...payload };
		const jobs = resolveDeliveryJobs(env, [
			{
				id: "01TEST00000000000000000004",
				payloadId: "01TEST00000000000000000000",
				destination: "OKAYAMA",
				payload,
			},
		]);

		await deliverJobs(
			jobs,
			{
				onDelivered: noopOnDelivered,
				onFailed: noopOnFailed,
			},
			true,
		);

		expect(payload).toStrictEqual(payloadCopy);
		expect(payload).not.toHaveProperty("__eventhub__");
	});
});
