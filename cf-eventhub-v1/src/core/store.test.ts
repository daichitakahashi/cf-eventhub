import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";

import { ULID_LENGTH } from "./id";
import {
	createPendingDeliveryJobs,
	listDeliveryJobStatuses,
	markDeliveryJobsFailed,
	persistDeliveryJobs,
} from "./store";
import type { Config } from "./routing";

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
	completed_at: string | null;
	retry_count: number;
	last_failed_at: string | null;
	last_error: string | null;
	next_retry_at: string;
	failed_at: string | null;
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

describe("persisted delivery jobs", () => {
	test("persists delivery jobs with monotonic ids from an injected generator", () => {
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
			createPendingDeliveryJobs(routeConfig, [{ kind: "nature", avoidUrban: false }]),
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
		const stub = getStub("persisted-delivery-jobs");
		const payload1 = { kind: "culture", avoidUrban: true };
		const payload2 = { kind: "nature", avoidUrban: false };

		await stub.publish(payload1, payload2);

		await runInDurableObject(stub, async (_instance, state) => {
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
							completed_at,
							retry_count,
							last_failed_at,
							last_error,
							next_retry_at,
							failed_at
						FROM delivery_jobs
						ORDER BY id
					`,
				)
				.toArray();

			expect(payloads).toHaveLength(2);
			expect(payloads.every((payload) => payload.id.length === ULID_LENGTH)).toBe(
				true,
			);
			expect(payloads.map((payload) => payload.id).sort()).toStrictEqual(
				payloads.map((payload) => payload.id),
			);
			expect(JSON.parse(payloads[0].body)).toStrictEqual(payload1);
			expect(JSON.parse(payloads[1].body)).toStrictEqual(payload2);
			expect(deliveryJobs).toHaveLength(3);
			expect(
				deliveryJobs.every((deliveryJob) => deliveryJob.id.length === ULID_LENGTH),
			).toBe(true);
			expect(deliveryJobs.map((job) => job.destination)).toStrictEqual([
				"OKAYAMA",
				"HOKKAIDO",
				"OKINAWA",
			]);
			expect(
				deliveryJobs.every((deliveryJob) =>
					payloads.some((payload) => payload.id === deliveryJob.payload_id),
				),
			).toBe(true);
			expect(deliveryJobs.every((job) => job.retry_count === 0)).toBe(true);
			expect(deliveryJobs.every((job) => job.last_failed_at === null)).toBe(true);
			expect(deliveryJobs.every((job) => job.last_error === null)).toBe(true);
			expect(deliveryJobs.every((job) => job.failed_at === null)).toBe(true);
			expect(
				deliveryJobs.every((job) => job.next_retry_at >= job.created_at),
			).toBe(true);
		});
	});

	test("persists payload even when no destination matches", async () => {
		const stub = getStub("payload-only");
		const payload = { kind: "other" };

		await stub.publish(payload);

		await runInDurableObject(stub, async (_instance, state) => {
			const payloads = state.storage.sql
				.exec<PayloadRow>("SELECT id, body FROM payloads ORDER BY id")
				.toArray();
			const deliveryJobs = state.storage.sql
				.exec<DeliveryJobRow>("SELECT id FROM delivery_jobs")
				.toArray();

			expect(payloads).toHaveLength(1);
			expect(JSON.parse(payloads[0].body)).toStrictEqual(payload);
			expect(deliveryJobs).toHaveLength(0);
		});
	});

	test("records completed_at after waitUntil delivery succeeds", async () => {
		const stub = getStub("completed-at");

		await stub.publish({ kind: "nature", avoidUrban: false });

		await vi.waitFor(async () => {
			await runInDurableObject(stub, async (_instance, state) => {
				const deliveryJobs = state.storage.sql
					.exec<DeliveryJobRow>(
						`
							SELECT
								id,
								payload_id,
								destination,
								created_at,
								completed_at,
								retry_count,
								last_failed_at,
								last_error,
								next_retry_at,
								failed_at
							FROM delivery_jobs
							ORDER BY id
						`,
					)
					.toArray();

				expect(deliveryJobs).toHaveLength(2);
				expect(deliveryJobs.every((job) => job.completed_at !== null)).toBe(
					true,
				);
			});
		});
	});

	test("alarm completes a due delivery job", async () => {
		const stub = getStub("alarm-completes-due-job");
		let retriedJobId = "";

		await stub.publish({ kind: "nature", avoidUrban: false });

		await vi.waitFor(async () => {
			await runInDurableObject(stub, async (_instance, state) => {
				const statuses = listDeliveryJobStatuses(state.storage.sql);
				expect(statuses).toHaveLength(2);
				expect(statuses.every((job) => job.completedAt !== null)).toBe(true);
			});
		});

		await runInDurableObject(stub, async (instance, state) => {
			const [job] = listDeliveryJobStatuses(state.storage.sql);
			expect(job).toBeDefined();
			if (!job) {
				throw new Error("expected a delivery job");
			}
			retriedJobId = job.id;
			state.storage.transactionSync(() => {
				state.storage.sql.exec(
					`
						UPDATE delivery_jobs
						SET completed_at = NULL,
							retry_count = 1,
							last_failed_at = ?,
							last_error = ?,
							next_retry_at = ?
						WHERE id = ?
					`,
					"2026-05-04T00:00:00.000Z",
					"temporary failure",
					new Date(Date.now() - 1_000).toISOString(),
					job.id,
				);
			});

			await instance.alarm?.();
		});

		await runInDurableObject(stub, async (_instance, state) => {
			const statuses = listDeliveryJobStatuses(state.storage.sql);
			expect(
				statuses.find((job) => job.id === retriedJobId)?.completedAt,
			).not.toBeNull();
		});
	});

	test("reschedules the alarm when the next retry is moved later", async () => {
		const stub = getStub("alarm-reschedule");
		const futureRetryAt = new Date(Date.now() + 10 * 60 * 1_000);
		const currentAlarm = new Date(Date.now() + 5 * 1_000);

		await runInDurableObject(stub, async (instance, state) => {
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
				state.storage.sql.exec(
					`
						UPDATE delivery_jobs
						SET next_retry_at = ?
						WHERE id = ?
					`,
					futureRetryAt.toISOString(),
					job.id,
				);
			});
			await state.storage.setAlarm(currentAlarm);

			await instance.alarm?.();

			expect(await state.storage.getAlarm()).toBe(futureRetryAt.getTime());
		});
	});

	test("marks jobs as failed only after the configured number of retries is exhausted", async () => {
		const stub = getStub("failed-at");

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
			expect(updatedJob.failedAt).toBeNull();
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
			expect(updatedJob.failedAt).toBe("2026-05-04T00:00:10.000Z");
			expect(updatedJob.lastFailedAt).toBe("2026-05-04T00:00:10.000Z");
			expect(updatedJob.lastError).toBe("queue unavailable");
		});
	});
});
