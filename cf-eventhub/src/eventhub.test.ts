import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, describe, expect, test, vi } from "vitest";

import {
  createPendingDeliveryJobs,
  listDeliveryJobStatuses,
  persistDeliveryJobs,
} from "./core/store";
import { TestEventHub, type TestEventHubWithJobId, testRouting } from "./test";

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

const getStub = (name: string) =>
  env.EVENT_HUB.get(env.EVENT_HUB.idFromName(name));

const getStubWithJobId = (name: string) =>
  env.EVENT_HUB_WITH_JOB_ID.get(env.EVENT_HUB_WITH_JOB_ID.idFromName(name));

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

      expect(payloads.map((payload) => JSON.parse(payload.body))).toStrictEqual(
        [payload1, payload2],
      );
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

      expect(
        payloads.map((storedPayload) => JSON.parse(storedPayload.body)),
      ).toStrictEqual([payload]);
      expect(deliveryJobs).toStrictEqual([]);
    });
  });

  test("lists live payloads through RPC", async () => {
    // 1. Publish routed and unroutable payloads through the Durable Object entrypoint.
    // 2. Page through live payloads and verify delivery job metadata is included.
    const stub = getStub("list-live-payloads");

    await stub.publish(
      { kind: "culture", ordinal: 1 },
      { kind: "nature", ordinal: 2 },
      { kind: "other", ordinal: 3 },
    );

    const firstPage = await stub.list({ max: 2, maxBytes: 262_144 });
    const secondPage = await stub.list({
      cursor: firstPage.cursor,
      max: 2,
      maxBytes: 262_144,
    });

    expect({
      firstPage,
      secondPayloads: secondPage.payloads.map(({ payload }) => payload),
    }).toMatchObject({
      firstPage: {
        cursor: expect.any(String),
        payloads: [
          {
            payload: { kind: "culture", ordinal: 1 },
            deliveryJobs: [{ destination: "OKAYAMA" }],
          },
          {
            payload: { kind: "nature", ordinal: 2 },
            deliveryJobs: [
              { destination: "HOKKAIDO" },
              { destination: "OKINAWA" },
            ],
          },
        ],
      },
      secondPayloads: [{ kind: "other", ordinal: 3 }],
    });
    expect(secondPage.cursor).toBeUndefined();
  });

  test("lists live payloads by creation time descending through RPC", async () => {
    const stub = getStub("list-live-payloads-desc");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      state.storage.transactionSync(() => {
        for (const ordinal of [1, 2, 3]) {
          persistDeliveryJobs(
            state.storage.sql,
            createPendingDeliveryJobs(testRouting, [
              { kind: "other", ordinal },
            ]),
            () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
            new Date(`2026-05-04T00:0${ordinal}:00.000Z`),
            10_000,
          );
        }
      });
    });

    const firstPage = await stub.list({ order: "desc", max: 2 });
    const secondPage = await stub.list({
      order: "desc",
      cursor: firstPage.cursor,
      max: 2,
    });

    expect({
      firstPayloads: firstPage.payloads.map(({ payload }) => payload),
      secondPayloads: secondPage.payloads.map(({ payload }) => payload),
    }).toStrictEqual({
      firstPayloads: [
        { kind: "other", ordinal: 3 },
        { kind: "other", ordinal: 2 },
      ],
      secondPayloads: [{ kind: "other", ordinal: 1 }],
    });
    expect(firstPage.cursor).toEqual(expect.any(String));
    expect(secondPage.cursor).toBeUndefined();
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

        expect(deliveryJobs).toMatchObject([
          {
            final_status: "completed",
            finalized_at: expect.any(String),
          },
          {
            final_status: "completed",
            finalized_at: expect.any(String),
          },
        ]);
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
        expect(statuses).toMatchObject([
          { finalStatus: "completed" },
          { finalStatus: "completed" },
        ]);
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
          createPendingDeliveryJobs(testRouting, [
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

        expect(deliveryJobs).toMatchObject([
          { final_status: "completed" },
          { final_status: "completed" },
        ]);
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

  test("returns a singleton ejection key through RPC", async () => {
    // 1. Seed payloads that cover ejection candidates, recently finalized rows, and still-live rows.
    // 2. Call the public eject RPC with the cutoff.
    // 3. Verify the RPC exposes only the singleton ejection key.
    const stub = getStub("eventhub-eject");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(testRouting, [
            { kind: "culture", avoidUrban: true },
            { kind: "nature", avoidUrban: false },
          ]),
          () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
          new Date("2026-05-04T00:00:00.000Z"),
          10_000,
        ),
      );
      state.storage.transactionSync(() => {
        const recentlyFinalizedJobs = persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(testRouting, [
            { kind: "nature", avoidUrban: true, freshness: "recent" },
          ]),
          () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
          new Date("2026-05-03T00:00:00.000Z"),
          10_000,
        );
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(testRouting, [{ kind: "other" }]),
          () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
          new Date("2026-05-04T00:00:30.000Z"),
          10_000,
        );
        markAllCompleted(
          state.storage.sql,
          jobs.map((job) => job.id),
        );
        markAllCompleted(
          state.storage.sql,
          recentlyFinalizedJobs.map((job) => job.id),
          "2026-05-06T00:00:00.000Z",
        );
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(testRouting, [
            { kind: "culture", avoidUrban: false },
          ]),
          () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
          new Date("2026-05-06T00:00:00.000Z"),
          10_000,
        );
      });
    });

    const firstEjection = await stub.eject(
      new Date("2026-05-05T00:00:00.000Z").getTime(),
    );
    expect(firstEjection).toStrictEqual({
      ejectKey: expect.any(String),
    });
  });

  test("lists the first ejected payload page through RPC", async () => {
    const stub = getStub("eventhub-eject-list");

    await seedEjectionScenario(stub);

    const firstEjection = await stub.eject(
      new Date("2026-05-05T00:00:00.000Z").getTime(),
    );
    if (firstEjection.ejectKey === null) {
      throw new Error("expected an ejection key");
    }

    const firstPage = await stub.listEjected(firstEjection.ejectKey, {
      max: 2,
      maxBytes: 262_144,
    });
    expect(firstPage).toMatchObject({
      cursor: expect.any(String),
      payloads: [
        {
          payload: { kind: "culture", avoidUrban: true },
          deliveryJobs: [{ finalStatus: "completed" }],
        },
        {
          payload: { kind: "nature", avoidUrban: false },
          deliveryJobs: [
            { finalStatus: "completed" },
            { finalStatus: "completed" },
          ],
        },
      ],
    });
  });

  test("continues ejected payload pagination through RPC until exhaustion", async () => {
    const stub = getStub("eventhub-eject-list-cursor");

    await seedEjectionScenario(stub);

    const firstEjection = await stub.eject(
      new Date("2026-05-05T00:00:00.000Z").getTime(),
    );
    if (firstEjection.ejectKey === null) {
      throw new Error("expected an ejection key");
    }

    const firstPage = await stub.listEjected(firstEjection.ejectKey, {
      max: 2,
      maxBytes: 262_144,
    });

    const secondPage = await stub.listEjected(firstEjection.ejectKey, {
      cursor: firstPage.cursor,
      max: 2,
      maxBytes: 262_144,
    });
    const allPayloads = [...firstPage.payloads, ...secondPage.payloads].map(
      ({ payload }) => payload,
    );
    expect({
      secondPage,
      allPayloads,
    }).toMatchObject({
      secondPage: {
        payloads: [{ payload: { kind: "other" }, deliveryJobs: [] }],
      },
      allPayloads: [
        { kind: "culture", avoidUrban: true },
        { kind: "nature", avoidUrban: false },
        { kind: "other" },
      ],
    });
    expect(secondPage.cursor).toBeUndefined();
  });

  test("returns the same active ejection key until eviction", async () => {
    const stub = getStub("eventhub-eject-repeat");

    await seedEjectionScenario(stub);

    const firstEjection = await stub.eject(
      new Date("2026-05-05T00:00:00.000Z").getTime(),
    );
    const repeatedEjection = await stub.eject(
      new Date("2026-05-06T00:00:00.000Z").getTime(),
    );
    expect(repeatedEjection).toStrictEqual(firstEjection);
  });

  test("removes the snapshot from source storage and clears it after eviction", async () => {
    const stub = getStub("eventhub-eject-evict");

    await seedEjectionScenario(stub);

    const firstEjection = await stub.eject(
      new Date("2026-05-05T00:00:00.000Z").getTime(),
    );
    if (firstEjection.ejectKey === null) {
      throw new Error("expected an ejection key");
    }

    await runInDurableObject(stub, async (_instance, state) => {
      const payloads = state.storage.sql
        .exec<PayloadRow>("SELECT id, body FROM payloads ORDER BY id")
        .toArray();
      expect(payloads).toHaveLength(2);
      expect(payloads.map((payload) => JSON.parse(payload.body))).toStrictEqual(
        [
          { kind: "nature", avoidUrban: true, freshness: "recent" },
          { kind: "culture", avoidUrban: false },
        ],
      );
    });

    await stub.evict(firstEjection.ejectKey);
    await stub.evict(firstEjection.ejectKey);

    const afterEviction = await stub.eject(
      new Date("2026-05-05T00:00:00.000Z").getTime(),
    );
    expect(afterEviction).toStrictEqual({ ejectKey: null });
    expect(await stub.listEjected(firstEjection.ejectKey)).toStrictEqual({
      payloads: [],
    });
  });

  test("rejects invalid ejection RPC inputs", async () => {
    const stub = getStub("eventhub-eject-invalid-inputs");

    await runInDurableObject(stub, async (instance) => {
      assert(instance instanceof TestEventHub);

      await expect(instance.list({ max: 101 })).rejects.toThrow(
        "eventhub: max must be <= 100",
      );
      await expect(instance.list({ maxBytes: 262_145 })).rejects.toThrow(
        "eventhub: maxBytes must be <= 262144",
      );
      await expect(instance.list({ order: "newest" as "asc" })).rejects.toThrow(
        'eventhub: order must be "asc" or "desc"',
      );
      await expect(instance.eject(Date.now(), { max: 101 })).rejects.toThrow(
        "eventhub: max must be <= 100",
      );
      await expect(instance.listEjected("", {})).rejects.toThrow(
        "eventhub: ejectKey must not be empty",
      );
      await expect(
        instance.listEjected("01EJECT00000000000000000010", { max: 101 }),
      ).rejects.toThrow("eventhub: max must be <= 100");
      await expect(
        instance.listEjected("01EJECT00000000000000000010", {
          maxBytes: 262_145,
        }),
      ).rejects.toThrow("eventhub: maxBytes must be <= 262144");
      await expect(instance.evict("")).rejects.toThrow(
        "eventhub: ejectKey must not be empty",
      );
    });
  });
});

const seedEjectionScenario = async (stub: ReturnType<typeof getStub>) => {
  // 1. Seed finalized payloads that should be ejected by the cutoff.
  // 2. Seed a payload finalized after the cutoff and one still-active payload that must remain live.
  // 3. Seed a payload without delivery jobs so pagination covers both job-backed and jobless rows.
  await runInDurableObject(stub, async (_instance, state) => {
    let sequence = 0;
    const jobs = state.storage.transactionSync(() =>
      persistDeliveryJobs(
        state.storage.sql,
        createPendingDeliveryJobs(testRouting, [
          { kind: "culture", avoidUrban: true },
          { kind: "nature", avoidUrban: false },
        ]),
        () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
        new Date("2026-05-04T00:00:00.000Z"),
        10_000,
      ),
    );
    state.storage.transactionSync(() => {
      const recentlyFinalizedJobs = persistDeliveryJobs(
        state.storage.sql,
        createPendingDeliveryJobs(testRouting, [
          { kind: "nature", avoidUrban: true, freshness: "recent" },
        ]),
        () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
        new Date("2026-05-03T00:00:00.000Z"),
        10_000,
      );
      persistDeliveryJobs(
        state.storage.sql,
        createPendingDeliveryJobs(testRouting, [{ kind: "other" }]),
        () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
        new Date("2026-05-04T00:00:30.000Z"),
        10_000,
      );
      markAllCompleted(
        state.storage.sql,
        jobs.map((job) => job.id),
      );
      markAllCompleted(
        state.storage.sql,
        recentlyFinalizedJobs.map((job) => job.id),
        "2026-05-06T00:00:00.000Z",
      );
      persistDeliveryJobs(
        state.storage.sql,
        createPendingDeliveryJobs(testRouting, [
          { kind: "culture", avoidUrban: false },
        ]),
        () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
        new Date("2026-05-06T00:00:00.000Z"),
        10_000,
      );
    });
  });
};

const markAllCompleted = (
  sql: SqlStorage,
  jobIds: string[],
  finalizedAt = "2026-05-04T00:01:00.000Z",
): void => {
  if (jobIds.length === 0) {
    return;
  }

  const placeholders = jobIds.map(() => "?").join(", ");
  sql.exec(
    `
			UPDATE delivery_jobs
			SET final_status = 'completed',
				finalized_at = ?,
				last_error = NULL
			WHERE id IN (${placeholders})
		`,
    finalizedAt,
    ...jobIds,
  );
};

describe("reportFailure", () => {
  test("records a consumer-reported failure for a delivery job", async () => {
    // 1. Publish a payload and extract the delivery job ID from the database.
    // 2. Call reportFailure with a payload containing the job ID.
    // 3. Verify the failure is recorded in delivery_job_failures.
    const stub = getStub("report-failure-basic");

    await stub.publish({ kind: "culture" });

    await runInDurableObject(stub, async (instance, state) => {
      const jobs = state.storage.sql
        .exec<DeliveryJobRow>("SELECT id FROM delivery_jobs")
        .toArray();

      assert(jobs.length > 0, "expected at least one delivery job");

      const payload = {
        kind: "culture",
        __eventhub__: { deliveryJobId: jobs[0]?.id ?? "" },
      };
      const recorded = await (instance as TestEventHub).reportFailure(payload);

      const failures = state.storage.sql
        .exec<{
          delivery_job_id: string;
          reported_at: string;
        }>("SELECT delivery_job_id, reported_at FROM delivery_job_failures")
        .toArray();

      expect(recorded).toBe(true);
      expect(failures).toMatchObject([
        {
          delivery_job_id: jobs[0]?.id,
          reported_at: expect.any(String),
        },
      ]);
    });
  });

  test("is idempotent and preserves the first timestamp", async () => {
    // 1. Publish a payload and record a failure.
    // 2. Call reportFailure again with the same payload.
    // 3. Verify the recorded timestamp is unchanged.
    const stub = getStub("report-failure-idempotent");

    await stub.publish({ kind: "culture" });

    await runInDurableObject(stub, async (instance, state) => {
      const jobs = state.storage.sql
        .exec<DeliveryJobRow>("SELECT id FROM delivery_jobs")
        .toArray();

      assert(jobs.length > 0, "expected at least one delivery job");

      const payload = {
        kind: "culture",
        __eventhub__: { deliveryJobId: jobs[0]?.id ?? "" },
      };

      const firstRecorded = await (instance as TestEventHub).reportFailure(
        payload,
      );
      const firstFailures = state.storage.sql
        .exec<{
          delivery_job_id: string;
          reported_at: string;
        }>("SELECT delivery_job_id, reported_at FROM delivery_job_failures")
        .toArray();

      const secondRecorded = await (instance as TestEventHub).reportFailure(
        payload,
      );
      const secondFailures = state.storage.sql
        .exec<{
          delivery_job_id: string;
          reported_at: string;
        }>("SELECT delivery_job_id, reported_at FROM delivery_job_failures")
        .toArray();

      expect({ firstRecorded, secondRecorded }).toStrictEqual({
        firstRecorded: true,
        secondRecorded: false,
      });
      expect(firstFailures).toStrictEqual(secondFailures);
    });
  });

  test("throws when payload is not an object", async () => {
    // 1. Attempt to call reportFailure with a non-object value.
    // 2. Verify it throws an error.
    const stub = getStub("report-failure-not-object");

    await runInDurableObject(stub, async (instance, _state) => {
      await expect(
        (instance as TestEventHub).reportFailure("string"),
      ).rejects.toThrow("eventhub: payload must be an object");
      await expect(
        (instance as TestEventHub).reportFailure(123),
      ).rejects.toThrow("eventhub: payload must be an object");
      await expect(
        (instance as TestEventHub).reportFailure(null),
      ).rejects.toThrow("eventhub: payload must be an object");
      await expect(
        (instance as TestEventHub).reportFailure(undefined),
      ).rejects.toThrow("eventhub: payload must be an object");
    });
  });

  test("throws when __eventhub__ is not present in payload", async () => {
    // 1. Attempt to call reportFailure with a payload that lacks __eventhub__.
    // 2. Verify it throws an error.
    const stub = getStub("report-failure-missing-eventhub");

    await runInDurableObject(stub, async (instance, _state) => {
      const payload = { kind: "culture" };
      await expect(
        (instance as TestEventHub).reportFailure(payload),
      ).rejects.toThrow(
        "eventhub: __eventhub__ metadata not found or invalid in payload",
      );
    });
  });

  test("throws when __eventhub__ is an array", async () => {
    // 1. Attempt to call reportFailure with __eventhub__ as an array.
    // 2. Verify it throws an error.
    const stub = getStub("report-failure-eventhub-array");

    await runInDurableObject(stub, async (instance, _state) => {
      const payload = { kind: "culture", __eventhub__: [] };
      await expect(
        (instance as TestEventHub).reportFailure(payload),
      ).rejects.toThrow(
        "eventhub: __eventhub__ metadata not found or invalid in payload",
      );
    });
  });

  test("throws when deliveryJobId is not present in __eventhub__", async () => {
    // 1. Attempt to call reportFailure with __eventhub__ that lacks deliveryJobId.
    // 2. Verify it throws an error.
    const stub = getStub("report-failure-missing-id");

    await runInDurableObject(stub, async (instance, _state) => {
      const payload = {
        kind: "culture",
        __eventhub__: { otherField: "value" },
      };
      await expect(
        (instance as TestEventHub).reportFailure(payload),
      ).rejects.toThrow("eventhub: deliveryJobId must be a non-empty string");
    });
  });

  test("throws when deliveryJobId is empty string", async () => {
    // 1. Attempt to call reportFailure with a payload containing an empty job ID.
    // 2. Verify it throws an error.
    const stub = getStub("report-failure-empty-id");

    await runInDurableObject(stub, async (instance, _state) => {
      const payload = {
        kind: "culture",
        __eventhub__: { deliveryJobId: "" },
      };
      await expect(
        (instance as TestEventHub).reportFailure(payload),
      ).rejects.toThrow("eventhub: deliveryJobId must be a non-empty string");
    });
  });

  test("throws when deliveryJobId is not a string", async () => {
    // 1. Attempt to call reportFailure with a payload containing a non-string job ID.
    // 2. Verify it throws an error.
    const stub = getStub("report-failure-non-string-id");

    await runInDurableObject(stub, async (instance, _state) => {
      const payload = {
        kind: "culture",
        __eventhub__: { deliveryJobId: 12345 },
      };
      await expect(
        (instance as TestEventHub).reportFailure(payload),
      ).rejects.toThrow("eventhub: deliveryJobId must be a non-empty string");
    });
  });

  test("records failures for multiple distinct jobs", async () => {
    // 1. Publish multiple payloads to create multiple delivery jobs.
    // 2. Record failures for each job using payloads.
    // 3. Verify all failures are recorded.
    const stub = getStub("report-failure-multiple");

    await stub.publish({ kind: "culture" }, { kind: "nature" });

    await runInDurableObject(stub, async (instance, state) => {
      const jobs = state.storage.sql
        .exec<DeliveryJobRow>("SELECT id FROM delivery_jobs ORDER BY id")
        .toArray();

      assert(jobs.length >= 2, "expected at least two delivery jobs");

      const payload1 = {
        kind: "culture",
        __eventhub__: { deliveryJobId: jobs[0]?.id ?? "" },
      };
      const payload2 = {
        kind: "nature",
        __eventhub__: { deliveryJobId: jobs[1]?.id ?? "" },
      };

      const recorded = await Promise.all([
        (instance as TestEventHub).reportFailure(payload1),
        (instance as TestEventHub).reportFailure(payload2),
      ]);

      const failures = state.storage.sql
        .exec<{
          delivery_job_id: string;
        }>(
          "SELECT delivery_job_id FROM delivery_job_failures ORDER BY delivery_job_id",
        )
        .toArray();

      expect(recorded).toStrictEqual([true, true]);
      expect(failures).toMatchObject([
        { delivery_job_id: jobs[0]?.id },
        { delivery_job_id: jobs[1]?.id },
      ]);
    });
  });

  test("returns false when the delivery job no longer exists", async () => {
    // 1. Call reportFailure with a valid-looking job ID that is not stored.
    // 2. Verify the method returns false and no failure record is created.
    const stub = getStub("report-failure-missing-job");

    await runInDurableObject(stub, async (instance, state) => {
      const recorded = await (instance as TestEventHub).reportFailure({
        kind: "culture",
        __eventhub__: { deliveryJobId: "missing_job_id" },
      });

      const failures = state.storage.sql
        .exec<{
          delivery_job_id: string;
        }>("SELECT delivery_job_id FROM delivery_job_failures")
        .toArray();

      expect({ recorded, failures }).toStrictEqual({
        recorded: false,
        failures: [],
      });
    });
  });
});

describe("redrive", () => {
  test("creates and delivers a new job from an existing delivery job", async () => {
    // 1. Publish a payload and wait for the original job to complete.
    // 2. Redrive the job and verify a separate job is delivered with a new ID.
    const stub = getStubWithJobId(
      "redrive-completed-job",
    ) as DurableObjectStub<TestEventHubWithJobId>;
    const payload = { type: "queue" };
    let originalJobId = "";

    await stub.publish(payload);

    await vi.waitFor(async () => {
      await runInDurableObject(stub, async (instance, state) => {
        const jobs = state.storage.sql
          .exec<Pick<DeliveryJobRow, "id" | "payload_id" | "finalized_at">>(
            "SELECT id, payload_id, finalized_at FROM delivery_jobs",
          )
          .toArray();

        expect(jobs).toMatchObject([{ finalized_at: expect.any(String) }]);
        originalJobId = jobs[0]?.id ?? "";
        expect(
          (instance as TestEventHubWithJobId).queue.sentBatches,
        ).toStrictEqual([
          [
            {
              body: {
                ...payload,
                __eventhub__: { deliveryJobId: originalJobId },
              },
              contentType: "json",
            },
          ],
        ]);
      });
    });

    const redriven = await stub.redrive(originalJobId);

    expect(redriven).toBe(true);
    await vi.waitFor(async () => {
      await runInDurableObject(stub, async (instance, state) => {
        const payloads = state.storage.sql
          .exec<PayloadRow>("SELECT id, body FROM payloads ORDER BY id")
          .toArray();
        const jobs = state.storage.sql
          .exec<
            Pick<
              DeliveryJobRow,
              "id" | "payload_id" | "final_status" | "finalized_at"
            >
          >(
            `
							SELECT id, payload_id, final_status, finalized_at
							FROM delivery_jobs
							ORDER BY created_at, id
						`,
          )
          .toArray();

        expect(jobs).toMatchObject([
          {
            id: originalJobId,
            final_status: "completed",
            finalized_at: expect.any(String),
          },
          {
            final_status: "completed",
            finalized_at: expect.any(String),
          },
        ]);

        const redrivenJobId = jobs[1]?.id ?? "";
        expect({
          distinctJobId: redrivenJobId !== originalJobId,
          distinctPayloadId: jobs[1]?.payload_id !== jobs[0]?.payload_id,
          storedPayloads: payloads.map((row) => JSON.parse(row.body)),
          sentBatches: (instance as TestEventHubWithJobId).queue.sentBatches,
        }).toStrictEqual({
          distinctJobId: true,
          distinctPayloadId: true,
          storedPayloads: [payload, payload],
          sentBatches: [
            [
              {
                body: {
                  ...payload,
                  __eventhub__: { deliveryJobId: originalJobId },
                },
                contentType: "json",
              },
            ],
            [
              {
                body: {
                  ...payload,
                  __eventhub__: { deliveryJobId: redrivenJobId },
                },
                contentType: "json",
              },
            ],
          ],
        });
      });
    });
  });

  test("returns false when the source job does not exist", async () => {
    const stub = getStub("redrive-missing-job");

    expect(await stub.redrive("missing_job_id")).toBe(false);
    await runInDurableObject(stub, async (_instance, state) => {
      const jobs = state.storage.sql
        .exec<DeliveryJobRow>("SELECT id FROM delivery_jobs")
        .toArray();
      expect(jobs).toStrictEqual([]);
    });
  });

  test("throws when deliveryJobId is empty", async () => {
    const stub = getStub("redrive-empty-id");

    await runInDurableObject(stub, async (instance, _state) => {
      await expect((instance as TestEventHub).redrive("")).rejects.toThrow(
        "eventhub: deliveryJobId must not be empty",
      );
    });
  });
});

describe("includeDeliveryJobId configuration", () => {
  test("delivers successfully when includeDeliveryJobId is false (default)", async () => {
    // 1. Publish payloads with default configuration (includeDeliveryJobId: false).
    // 2. Verify delivery completes successfully.
    const stub = getStub("no-job-id-default");
    const payload = { kind: "culture" };

    await stub.publish(payload);

    await vi.waitFor(async () => {
      await runInDurableObject(stub, async (_instance, state) => {
        const jobs = state.storage.sql
          .exec<DeliveryJobRow>("SELECT finalized_at FROM delivery_jobs")
          .toArray();
        expect(jobs).toMatchObject([{ finalized_at: expect.any(String) }]);
      });
    });
  });

  test("delivers successfully when includeDeliveryJobId is true", async () => {
    // 1. Configure EventHub with includeDeliveryJobId: true.
    // 2. Publish a payload and verify delivery completes with the injected job ID.
    const stub = getStubWithJobId(
      "with-job-id",
    ) as DurableObjectStub<TestEventHubWithJobId>;
    const payload = { type: "queue" };

    await stub.publish(payload);

    await vi.waitFor(async () => {
      await runInDurableObject(stub, async (instance, state) => {
        const jobs = state.storage.sql
          .exec<Pick<DeliveryJobRow, "id" | "finalized_at">>(
            "SELECT id, finalized_at FROM delivery_jobs",
          )
          .toArray();
        expect(jobs).toMatchObject([{ finalized_at: expect.any(String) }]);
        expect(
          (instance as TestEventHubWithJobId).queue.sentBatches,
        ).toStrictEqual([
          [
            {
              body: {
                ...payload,
                __eventhub__: { deliveryJobId: jobs[0]?.id },
              },
              contentType: "json",
            },
          ],
        ]);
      });
    });
  });

  test("DB-stored payloads do not contain injected job ID", async () => {
    // 1. Configure EventHub with includeDeliveryJobId: true.
    // 2. Publish a payload.
    // 3. Verify the payload stored in the database does not contain the job ID.
    const stub = getStubWithJobId(
      "db-without-job-id",
    ) as DurableObjectStub<TestEventHubWithJobId>;
    const payload = { type: "queue" };

    await stub.publish(payload);

    await runInDurableObject(stub, async (_instance, state) => {
      const payloads = state.storage.sql
        .exec<PayloadRow>("SELECT body FROM payloads")
        .toArray();

      expect(payloads).toHaveLength(1);
      const storedPayload = JSON.parse(payloads[0]?.body ?? "{}");
      expect(storedPayload).toStrictEqual(payload);
      expect(storedPayload).not.toHaveProperty("__eventhub__");
    });
  });
});
