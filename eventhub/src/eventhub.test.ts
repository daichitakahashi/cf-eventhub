import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";

import {
	createPendingDeliveryJobs,
	listDeliveryJobStatuses,
	persistDeliveryJobs,
} from "./core/store";
import type { Config } from "./core/routing";

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
		{
			condition: {
				path: "$.kind",
				exact: "archive",
			},
			destination: "ARCHIVE",
		},
	],
};

const getStub = (name: string) =>
	env.EVENT_HUB.get(env.EVENT_HUB.idFromName(name));

// @ts-expect-error
const getArchiveBucket = (): R2Bucket => env.ARCHIVE as R2Bucket;

describe("EventHub integration", () => {
	test("persists payloads and delivery jobs through publish", async () => {
		// 1. Publish routed payloads through the Durable Object entrypoint.
		// 2. Inspect storage to verify the persisted state.
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

			expect(payloads).toHaveLength(2);
			expect(JSON.parse(payloads[0].body)).toStrictEqual(payload1);
			expect(JSON.parse(payloads[1].body)).toStrictEqual(payload2);
			expect(deliveryJobs).toHaveLength(3);
			expect(deliveryJobs.map((job) => job.destination)).toStrictEqual([
				"OKAYAMA",
				"HOKKAIDO",
				"OKINAWA",
			]);
		});
	});

	test("persists payload even when no destination matches", async () => {
		// 1. Publish an unroutable payload through EventHub.
		// 2. Verify only the payload row is stored.
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
		// 1. Publish a payload and wait for async delivery to finish.
		// 2. Verify all created jobs are marked completed.
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

				expect(deliveryJobs).toHaveLength(2);
				expect(
					deliveryJobs.every((job) => job.final_status === "completed"),
				).toBe(true);
				expect(deliveryJobs.every((job) => job.finalized_at !== null)).toBe(
					true,
				);
			});
		});
	});

	test("alarm completes a due delivery job and clears the last error", async () => {
		// 1. Publish and complete jobs once, then rewind one job into a failed due state.
		// 2. Trigger alarm and verify the recovered job state.
		const stub = getStub("alarm-completes-due-job");
		let retriedJobId = "";

		await stub.publish({ kind: "nature", avoidUrban: false });

		await vi.waitFor(async () => {
			await runInDurableObject(stub, async (_instance, state) => {
				const statuses = listDeliveryJobStatuses(state.storage.sql);
				expect(statuses).toHaveLength(2);
				expect(statuses.every((job) => job.finalStatus === "completed")).toBe(
					true,
				);
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
						SET final_status = NULL,
							finalized_at = NULL,
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
			const retriedJob = listDeliveryJobStatuses(state.storage.sql).find(
				(job) => job.id === retriedJobId,
			);
			expect(retriedJob?.finalStatus).toBe("completed");
			expect(retriedJob?.finalizedAt).not.toBeNull();
			expect(retriedJob?.lastError).toBeNull();
		});
	});

	test("reschedules the alarm when the next retry is moved later", async () => {
		// 1. Seed a persisted job and move its retry time into the future.
		// 2. Run alarm and verify the next alarm is rescheduled.
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

	test("writes routed payloads to R2 buckets through publish", async () => {
		// 1. Publish an R2-routed payload through the Durable Object entrypoint.
		// 2. Verify the persisted delivery job is completed and the bucket object matches the payload.
		const stub = getStub("r2-publish");
		const payload = { kind: "archive", avoidUrban: false, region: "west" };
		let archiveJob: DeliveryJobRow | undefined;

		await stub.publish(payload);

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
								final_status,
								finalized_at,
								retry_count,
								last_failed_at,
								last_error,
								next_retry_at
							FROM delivery_jobs
							WHERE destination = 'ARCHIVE'
						`,
					)
					.toArray();

				expect(deliveryJobs).toHaveLength(1);
				[archiveJob] = deliveryJobs;
				expect(archiveJob?.final_status).toBe("completed");
			});
		});

		expect(archiveJob).toBeDefined();
		if (!archiveJob) {
			throw new Error("expected an archive job");
		}

		const object = await getArchiveBucket().get(
			`${archiveJob.payload_id}/${archiveJob.id}.json`,
		);
		expect(object).not.toBeNull();
		expect(await object?.json()).toStrictEqual(payload);
	});

	test("delivers queue and R2 destinations in the same publish call", async () => {
		// 1. Publish one queue-routed payload and one R2-routed payload together.
		// 2. Verify both delivery paths complete independently.
		const stub = getStub("mixed-destinations");
		let archiveJob: DeliveryJobRow | undefined;

		await stub.publish(
			{ kind: "culture", avoidUrban: true },
			{ kind: "archive", avoidUrban: false },
		);

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
								final_status,
								finalized_at,
								retry_count,
								last_failed_at,
								last_error,
								next_retry_at
							FROM delivery_jobs
							ORDER BY destination
						`,
					)
					.toArray();

				expect(deliveryJobs).toHaveLength(2);
				expect(
					deliveryJobs.every((job) => job.final_status === "completed"),
				).toBe(true);
				archiveJob = deliveryJobs.find((job) => job.destination === "ARCHIVE");
			});
		});

		expect(archiveJob).toBeDefined();
		if (!archiveJob) {
			throw new Error("expected an archive job");
		}

		const object = await getArchiveBucket().get(
			`${archiveJob.payload_id}/${archiveJob.id}.json`,
		);
		expect(object).not.toBeNull();
		expect(await object?.json()).toStrictEqual({
			kind: "archive",
			avoidUrban: false,
		});
	});
});
