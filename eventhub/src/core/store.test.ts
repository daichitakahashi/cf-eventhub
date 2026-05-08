import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";

import type { Config } from "./routing";
import {
	createPendingDeliveryJobs,
	ejectPayloads,
	getNextRetryAt,
	listDeliverableJobs,
	listDeliveryJobStatuses,
	markDeliveryJobsCompleted,
	markDeliveryJobsFailed,
	persistDeliveryJobs,
} from "./store";

type PayloadRow = {
	id: string;
	body: string;
	created_at: string;
};

type DeliveryJobRow = {
	id: string;
	payload_id: string;
	destination: string;
	created_at: string;
	final_status: "completed" | "failed" | null;
	finalized_at: string | null;
	retry_count: number;
	last_failed_at: string | null;
	last_error: string | null;
	next_retry_at: string;
};

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

const getStub = (name: string) =>
	env.EVENT_HUB.get(env.EVENT_HUB.idFromName(name));

describe("createPendingDeliveryJobs", () => {
	test("evaluates routes once and builds a delivery job plan", () => {
		// 1. Route several payloads through the config.
		// 2. Verify each payload is paired with the selected destinations.
		const payloads = [
			{ kind: "culture", avoidUrban: true },
			{ kind: "nature", avoidUrban: false },
			{ kind: "other" },
		] as const;

		expect(createPendingDeliveryJobs(routeConfig, payloads)).toStrictEqual({
			payloads: [
				{
					payload: payloads[0],
					destinations: ["OKAYAMA"],
				},
				{
					payload: payloads[1],
					destinations: ["HOKKAIDO", "OKINAWA"],
				},
				{
					payload: payloads[2],
					destinations: [],
				},
			],
		});
	});
});

describe("persistDeliveryJobs", () => {
	test("persists delivery jobs with monotonic ids from an injected generator", () => {
		// 1. Inject deterministic IDs and persist one routed payload.
		// 2. Verify the generated rows and returned jobs match.
		const sql = {
			exec: vi.fn(),
		} as unknown as SqlStorage;
		const ids = [
			"01TEST00000000000000000000",
			"01TEST00000000000000000001",
			"01TEST00000000000000000002",
		];
		const generateId = vi.fn(() => ids.shift() ?? "");

		const jobs = persistDeliveryJobs(
			sql,
			createPendingDeliveryJobs(routeConfig, [
				{ kind: "nature", avoidUrban: false },
			]),
			generateId,
			new Date("2026-05-04T00:00:00.000Z"),
			10_000,
		);

		expect(generateId).toHaveBeenCalledTimes(3);
		expect(sql.exec).toHaveBeenCalledWith(
			expect.stringContaining("INSERT INTO delivery_jobs"),
			"01TEST00000000000000000001",
			"01TEST00000000000000000000",
			"HOKKAIDO",
			"2026-05-04T00:00:00.000Z",
			"2026-05-04T00:00:10.000Z",
		);
		expect(jobs).toStrictEqual([
			{
				id: "01TEST00000000000000000001",
				payloadId: "01TEST00000000000000000000",
				destination: "HOKKAIDO",
				payload: { kind: "nature", avoidUrban: false },
			},
			{
				id: "01TEST00000000000000000002",
				payloadId: "01TEST00000000000000000000",
				destination: "OKINAWA",
				payload: { kind: "nature", avoidUrban: false },
			},
		]);
	});

	test("persists payloads and delivery jobs in SQLite", async () => {
		// 1. Persist routed payloads into the DO SQLite store.
		// 2. Inspect raw tables to verify stored payload and job state.
		const stub = getStub("store-persists-delivery-jobs");

		await runInDurableObject(stub, async (_instance, state) => {
			let sequence = 0;
			state.storage.transactionSync(() => {
				persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [
						{ kind: "culture", avoidUrban: true },
						{ kind: "nature", avoidUrban: false },
					]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-04T00:00:00.000Z"),
					10_000,
				);
			});

			const payloads = state.storage.sql
				.exec<PayloadRow>(
					"SELECT id, body, created_at FROM payloads ORDER BY id",
				)
				.toArray();
			const deliveryJobs = state.storage.sql
				.exec<DeliveryJobRow>(
					`
						SELECT
							id,
							payload_id,
							destination,
							created_at,
							final_status,
							finalized_at,
							retry_count,
							last_failed_at,
							last_error,
							next_retry_at
						FROM delivery_jobs
						ORDER BY id
					`,
				)
				.toArray();

			expect(payloads.map((payload) => payload.id).sort()).toStrictEqual(
				payloads.map((payload) => payload.id),
			);
			expect(payloads.map((payload) => JSON.parse(payload.body))).toStrictEqual([
				{
					kind: "culture",
					avoidUrban: true,
				},
				{
					kind: "nature",
					avoidUrban: false,
				},
			]);
			expect(deliveryJobs.map((job) => job.destination)).toStrictEqual([
				"OKAYAMA",
				"HOKKAIDO",
				"OKINAWA",
			]);
			expect(
				deliveryJobs.map((job) => ({
					...job,
					hasValidRetryAt: job.next_retry_at >= job.created_at,
				})),
			).toMatchObject([
				{
					payload_id: payloads[0]?.id,
					retry_count: 0,
					last_failed_at: null,
					last_error: null,
					final_status: null,
					finalized_at: null,
					hasValidRetryAt: true,
				},
				{
					payload_id: payloads[1]?.id,
					retry_count: 0,
					last_failed_at: null,
					last_error: null,
					final_status: null,
					finalized_at: null,
					hasValidRetryAt: true,
				},
				{
					payload_id: payloads[1]?.id,
					retry_count: 0,
					last_failed_at: null,
					last_error: null,
					final_status: null,
					finalized_at: null,
					hasValidRetryAt: true,
				},
			]);
		});
	});

	test("persists payload even when no destination matches", async () => {
		// 1. Persist an unroutable payload directly into storage.
		// 2. Verify no delivery jobs are created beside the payload row.
		const stub = getStub("store-payload-only");

		await runInDurableObject(stub, async (_instance, state) => {
			let sequence = 0;
			state.storage.transactionSync(() => {
				persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [{ kind: "other" }]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-04T00:00:00.000Z"),
					10_000,
				);
			});

			const payloads = state.storage.sql
				.exec<PayloadRow>("SELECT id, body FROM payloads ORDER BY id")
				.toArray();
			const deliveryJobs = state.storage.sql
				.exec<DeliveryJobRow>("SELECT id FROM delivery_jobs")
				.toArray();

			expect(payloads.map((payload) => JSON.parse(payload.body))).toStrictEqual([
				{ kind: "other" },
			]);
			expect(deliveryJobs).toStrictEqual([]);
		});
	});
});

describe("ejectPayloads", () => {
	test("returns payloads whose last finalization is older than the cutoff and deletes them", async () => {
		// 1. Seed payloads finalized before and after the cutoff, plus a newer active payload.
		// 2. Eject by cutoff and verify recently finalized payloads are retained.
		const stub = getStub("store-eject-payloads");

		await runInDurableObject(stub, async (_instance, state) => {
			let sequence = 0;
			const createdJobs = state.storage.transactionSync(() =>
				persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [
						{ kind: "culture", avoidUrban: true },
						{ kind: "nature", avoidUrban: false },
					]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-04T00:00:00.000Z"),
					10_000,
				),
			);
			state.storage.transactionSync(() => {
				markDeliveryJobsCompleted(
					state.storage.sql,
					[createdJobs[0].id],
					new Date("2026-05-04T00:01:00.000Z"),
				);
				markDeliveryJobsFailed(
					state.storage.sql,
					createdJobs.slice(1).map((job) => job.id),
					0,
					10_000,
					10_000,
					new Error("permanent failure"),
					new Date("2026-05-04T00:02:00.000Z"),
				);
				const recentlyFinalizedJobs = persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [
						{ kind: "nature", avoidUrban: true, freshness: "recent" },
					]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-03T00:00:00.000Z"),
					10_000,
				);
				markDeliveryJobsCompleted(
					state.storage.sql,
					recentlyFinalizedJobs.map((job) => job.id),
					new Date("2026-05-06T00:00:00.000Z"),
				);
				persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [
						{ kind: "culture", avoidUrban: false },
					]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-06T00:00:00.000Z"),
					10_000,
				);
			});

			const ejected = state.storage.transactionSync(() =>
				ejectPayloads(
					state.storage.sql,
					new Date("2026-05-05T00:00:00.000Z").getTime(),
					50,
				),
			);

			expect(ejected).toMatchObject([
				{
					payload: { kind: "culture", avoidUrban: true },
					deliveryJobs: [{ finalStatus: "completed" }],
				},
				{
					payload: { kind: "nature", avoidUrban: false },
					deliveryJobs: [
						{ finalStatus: "failed" },
						{ finalStatus: "failed" },
					],
				},
			]);

			const payloads = state.storage.sql
				.exec<PayloadRow>("SELECT id, body FROM payloads ORDER BY id")
				.toArray();
			const deliveryJobs = state.storage.sql
				.exec<DeliveryJobRow>(
					"SELECT id, payload_id, destination, created_at, final_status, finalized_at, retry_count, last_failed_at, last_error, next_retry_at FROM delivery_jobs ORDER BY id",
				)
				.toArray();

			expect(payloads.map((payload) => JSON.parse(payload.body))).toStrictEqual(
				[
					{ kind: "nature", avoidUrban: true, freshness: "recent" },
					{ kind: "culture", avoidUrban: false },
				],
			);
			expect(deliveryJobs).toHaveLength(3);
			expect(
				deliveryJobs.filter((job) => job.final_status === null),
			).toHaveLength(1);
		});
	});

	test("respects max when ejecting eligible payloads", async () => {
		const stub = getStub("store-eject-payloads-max");

		await runInDurableObject(stub, async (_instance, state) => {
			let sequence = 0;
			const jobs = state.storage.transactionSync(() =>
				persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [
						{ kind: "culture", avoidUrban: true },
						{ kind: "culture", avoidUrban: false },
					]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-04T00:00:00.000Z"),
					10_000,
				),
			);
			state.storage.transactionSync(() => {
				markDeliveryJobsCompleted(
					state.storage.sql,
					jobs.map((job) => job.id),
					new Date("2026-05-04T00:01:00.000Z"),
				);
			});

			const ejected = state.storage.transactionSync(() =>
				ejectPayloads(
					state.storage.sql,
					new Date("2026-05-05T00:00:00.000Z").getTime(),
					1,
				),
			);
			expect(ejected).toHaveLength(1);

			const remainingPayloads = state.storage.sql
				.exec<PayloadRow>("SELECT id FROM payloads")
				.toArray();
			expect(remainingPayloads).toHaveLength(1);
		});
	});
});

describe("delivery job state transitions", () => {
	test("marks jobs as completed and clears the last error", async () => {
		// 1. Seed a job with a stored error and mark it completed.
		// 2. Verify the completion time and error cleanup.
		const stub = getStub("store-mark-completed");

		await runInDurableObject(stub, async (_instance, state) => {
			let sequence = 0;
			const [job] = state.storage.transactionSync(() =>
				persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [
						{ kind: "culture", avoidUrban: true },
					]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-04T00:00:00.000Z"),
					10_000,
				),
			);

			state.storage.transactionSync(() => {
				state.storage.sql.exec(
					`
						UPDATE delivery_jobs
						SET last_error = ?
						WHERE id = ?
					`,
					"temporary failure",
					job.id,
				);
				markDeliveryJobsCompleted(
					state.storage.sql,
					[job.id],
					new Date("2026-05-04T00:00:10.000Z"),
				);
			});

			const [updatedJob] = listDeliveryJobStatuses(state.storage.sql);
			expect(updatedJob.finalStatus).toBe("completed");
			expect(updatedJob.finalizedAt).toBe("2026-05-04T00:00:10.000Z");
			expect(updatedJob.lastError).toBeNull();
		});
	});

	test("marks jobs as failed only after the configured number of retries is exhausted", async () => {
		// 1. Persist one job and fail it twice under a one-retry policy.
		// 2. Verify retry metadata before and after exhaustion.
		const stub = getStub("store-failed-at");

		await runInDurableObject(stub, async (_instance, state) => {
			let sequence = 0;
			const [job] = state.storage.transactionSync(() =>
				persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [
						{ kind: "culture", avoidUrban: true },
					]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-04T00:00:00.000Z"),
					10_000,
				),
			);
			expect(job).toBeDefined();
			if (!job) {
				throw new Error("expected a delivery job");
			}
			state.storage.transactionSync(() => {
				markDeliveryJobsFailed(
					state.storage.sql,
					[job.id],
					1,
					10_000,
					900_000,
					new Error("queue unavailable"),
					new Date("2026-05-04T00:00:00.000Z"),
				);
			});

			let [updatedJob] = listDeliveryJobStatuses(state.storage.sql);
			expect(updatedJob.retryCount).toBe(1);
			expect(updatedJob.finalStatus).toBeNull();
			expect(updatedJob.finalizedAt).toBeNull();
			expect(updatedJob.lastFailedAt).toBe("2026-05-04T00:00:00.000Z");
			expect(updatedJob.lastError).toBe("queue unavailable");
			expect(updatedJob.nextRetryAt).toBe("2026-05-04T00:00:10.000Z");

			state.storage.transactionSync(() => {
				markDeliveryJobsFailed(
					state.storage.sql,
					[job.id],
					1,
					10_000,
					900_000,
					new Error("queue unavailable"),
					new Date("2026-05-04T00:00:10.000Z"),
				);
			});

			[updatedJob] = listDeliveryJobStatuses(state.storage.sql);
			expect(updatedJob.retryCount).toBe(2);
			expect(updatedJob.finalStatus).toBe("failed");
			expect(updatedJob.finalizedAt).toBe("2026-05-04T00:00:10.000Z");
			expect(updatedJob.lastFailedAt).toBe("2026-05-04T00:00:10.000Z");
			expect(updatedJob.lastError).toBe("queue unavailable");
		});
	});

	test("keeps a later completion as the final result after a terminal failure", async () => {
		// 1. Mark a job as terminally failed, then mark it completed as if a late duplicate delivery succeeded.
		// 2. Verify the final result is completed while retaining retry history.
		const stub = getStub("store-completion-overrides-failure");

		await runInDurableObject(stub, async (_instance, state) => {
			let sequence = 0;
			const [job] = state.storage.transactionSync(() =>
				persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [
						{ kind: "culture", avoidUrban: true },
					]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-04T00:00:00.000Z"),
					10_000,
				),
			);

			state.storage.transactionSync(() => {
				markDeliveryJobsFailed(
					state.storage.sql,
					[job.id],
					0,
					10_000,
					900_000,
					new Error("queue unavailable"),
					new Date("2026-05-04T00:00:00.000Z"),
				);
				markDeliveryJobsCompleted(
					state.storage.sql,
					[job.id],
					new Date("2026-05-04T00:00:05.000Z"),
				);
			});

			const [updatedJob] = listDeliveryJobStatuses(state.storage.sql);
			expect(updatedJob.finalStatus).toBe("completed");
			expect(updatedJob.finalizedAt).toBe("2026-05-04T00:00:05.000Z");
			expect(updatedJob.lastFailedAt).toBe("2026-05-04T00:00:00.000Z");
			expect(updatedJob.lastError).toBeNull();
		});
	});

	test("keeps an earlier completion as the final result after a late failure", async () => {
		// 1. Mark a job as completed, then apply a late failure update as if another delivery attempt finished afterwards.
		// 2. Verify the final result stays completed and the late failure is ignored.
		const stub = getStub("store-completion-wins-over-late-failure");

		await runInDurableObject(stub, async (_instance, state) => {
			let sequence = 0;
			const [job] = state.storage.transactionSync(() =>
				persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [
						{ kind: "culture", avoidUrban: true },
					]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-04T00:00:00.000Z"),
					10_000,
				),
			);

			state.storage.transactionSync(() => {
				markDeliveryJobsCompleted(
					state.storage.sql,
					[job.id],
					new Date("2026-05-04T00:00:05.000Z"),
				);
				markDeliveryJobsFailed(
					state.storage.sql,
					[job.id],
					0,
					10_000,
					900_000,
					new Error("queue unavailable"),
					new Date("2026-05-04T00:00:10.000Z"),
				);
			});

			const [updatedJob] = listDeliveryJobStatuses(state.storage.sql);
			expect(updatedJob.finalStatus).toBe("completed");
			expect(updatedJob.finalizedAt).toBe("2026-05-04T00:00:05.000Z");
			expect(updatedJob.lastFailedAt).toBeNull();
			expect(updatedJob.lastError).toBeNull();
		});
	});

	test("keeps the original completion timestamp on a duplicate success", async () => {
		// 1. Mark a job as completed twice with different timestamps.
		// 2. Verify the first completion timestamp is preserved.
		const stub = getStub("store-duplicate-completion");

		await runInDurableObject(stub, async (_instance, state) => {
			let sequence = 0;
			const [job] = state.storage.transactionSync(() =>
				persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [
						{ kind: "culture", avoidUrban: true },
					]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-04T00:00:00.000Z"),
					10_000,
				),
			);

			state.storage.transactionSync(() => {
				markDeliveryJobsCompleted(
					state.storage.sql,
					[job.id],
					new Date("2026-05-04T00:00:05.000Z"),
				);
				markDeliveryJobsCompleted(
					state.storage.sql,
					[job.id],
					new Date("2026-05-04T00:00:10.000Z"),
				);
			});

			const [updatedJob] = listDeliveryJobStatuses(state.storage.sql);
			expect(updatedJob.finalStatus).toBe("completed");
			expect(updatedJob.finalizedAt).toBe("2026-05-04T00:00:05.000Z");
			expect(updatedJob.lastError).toBeNull();
		});
	});
});

describe("delivery job scheduling", () => {
	test("lists only due jobs and orders them by retry schedule", async () => {
		// 1. Seed jobs with completed, failed, and due states.
		// 2. Verify only due active jobs are returned in retry order.
		const stub = getStub("store-list-deliverable-jobs");

		await runInDurableObject(stub, async (_instance, state) => {
			let sequence = 0;
			const jobs = state.storage.transactionSync(() =>
				persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [
						{ kind: "culture", avoidUrban: true },
						{ kind: "nature", avoidUrban: false },
						{ kind: "culture", avoidUrban: false },
					]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-04T00:00:00.000Z"),
					10_000,
				),
			);

			state.storage.transactionSync(() => {
				state.storage.sql.exec(
					`
						UPDATE delivery_jobs
						SET next_retry_at = ?, final_status = ?, finalized_at = ?
						WHERE id = ?
					`,
					"2026-05-04T00:00:05.000Z",
					"completed",
					"2026-05-04T00:00:06.000Z",
					jobs[0]?.id,
				);
				state.storage.sql.exec(
					`
						UPDATE delivery_jobs
						SET next_retry_at = ?, final_status = ?, finalized_at = ?
						WHERE id = ?
					`,
					"2026-05-04T00:00:01.000Z",
					"failed",
					"2026-05-04T00:00:02.000Z",
					jobs[1]?.id,
				);
				state.storage.sql.exec(
					`
						UPDATE delivery_jobs
						SET next_retry_at = ?
						WHERE id = ?
					`,
					"2026-05-04T00:00:03.000Z",
					jobs[2]?.id,
				);
			});

			const dueJobs = listDeliverableJobs(
				state.storage.sql,
				10,
				new Date("2026-05-04T00:00:04.000Z"),
			);

			expect(dueJobs.map((job) => job.id)).toStrictEqual([jobs[2]?.id]);
		});
	});

	test("returns the earliest retry timestamp among active jobs", async () => {
		// 1. Seed mixed job states and query the next retry timestamp.
		// 2. Complete the remaining active jobs and expect no next retry to remain.
		const stub = getStub("store-next-retry-at");

		await runInDurableObject(stub, async (_instance, state) => {
			let sequence = 0;
			const jobs = state.storage.transactionSync(() =>
				persistDeliveryJobs(
					state.storage.sql,
					createPendingDeliveryJobs(routeConfig, [
						{ kind: "culture", avoidUrban: true },
						{ kind: "nature", avoidUrban: false },
						{ kind: "culture", avoidUrban: false },
					]),
					() => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
					new Date("2026-05-04T00:00:00.000Z"),
					10_000,
				),
			);

			state.storage.transactionSync(() => {
				state.storage.sql.exec(
					`
						UPDATE delivery_jobs
						SET next_retry_at = ?, final_status = ?, finalized_at = ?
						WHERE id = ?
					`,
					"2026-05-04T00:00:01.000Z",
					"completed",
					"2026-05-04T00:00:02.000Z",
					jobs[0]?.id,
				);
				state.storage.sql.exec(
					`
						UPDATE delivery_jobs
						SET next_retry_at = ?, final_status = ?, finalized_at = ?
						WHERE id = ?
					`,
					"2026-05-04T00:00:02.000Z",
					"failed",
					"2026-05-04T00:00:03.000Z",
					jobs[1]?.id,
				);
				state.storage.sql.exec(
					`
						UPDATE delivery_jobs
						SET next_retry_at = ?
						WHERE id = ?
					`,
					"2026-05-04T00:00:04.000Z",
					jobs[2]?.id,
				);
				state.storage.sql.exec(
					`
						UPDATE delivery_jobs
						SET next_retry_at = ?
						WHERE id = ?
					`,
					"2026-05-04T00:00:03.000Z",
					jobs[3]?.id,
				);
			});

			expect(getNextRetryAt(state.storage.sql)).toBe(
				"2026-05-04T00:00:03.000Z",
			);

			state.storage.transactionSync(() => {
				state.storage.sql.exec(
					`
						UPDATE delivery_jobs
						SET final_status = ?, finalized_at = ?
						WHERE id IN (?, ?)
					`,
					"completed",
					"2026-05-04T00:00:05.000Z",
					jobs[2]?.id,
					jobs[3]?.id,
				);
			});

			expect(getNextRetryAt(state.storage.sql)).toBeNull();
		});
	});
});
