import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, describe, expect, test, vi } from "vitest";

import { routeByConfig } from "./routing";
import {
  advanceEvictionPage,
  completeAutomaticEviction,
  createAutomaticEjection,
  createPendingDeliveryJobs,
  deleteEvictionCandidates,
  ejectPayloads,
  evictEjection,
  getActiveEjection,
  getEvictionRun,
  getNextEvictionBaseline,
  getNextRetryAt,
  list,
  listDeliverableJobs,
  listDeliveryJobStatuses,
  listEjected,
  markDeliveryJobsCompleted,
  markDeliveryJobsFailed,
  persistDeliveryJobs,
  recordDeliveryJobFailure,
  recordEvictionFailure,
  redriveDeliveryJob,
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

type EjectionRow = {
  key: string;
  before_at: string;
};

const routing = routeByConfig<{
  OKAYAMA: Queue;
  HOKKAIDO: Queue;
  OKINAWA: Queue;
}>(
  env as unknown as {
    OKAYAMA: Queue;
    HOKKAIDO: Queue;
    OKINAWA: Queue;
  },
  {
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
  },
);

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

    expect(createPendingDeliveryJobs(routing, payloads)).toStrictEqual({
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
      createPendingDeliveryJobs(routing, [
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
          createPendingDeliveryJobs(routing, [
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
      expect(payloads.map((payload) => JSON.parse(payload.body))).toStrictEqual(
        [
          {
            kind: "culture",
            avoidUrban: true,
          },
          {
            kind: "nature",
            avoidUrban: false,
          },
        ],
      );
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
          createPendingDeliveryJobs(routing, [{ kind: "other" }]),
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

      expect(payloads.map((payload) => JSON.parse(payload.body))).toStrictEqual(
        [{ kind: "other" }],
      );
      expect(deliveryJobs).toStrictEqual([]);
    });
  });
});

describe("redriveDeliveryJob", () => {
  test("creates an independent payload and job from an existing job", async () => {
    // 1. Persist and finalize an original delivery job.
    // 2. Redrive it and verify the new job has fresh IDs and reset retry state.
    const stub = getStub("store-redrive-job");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const [originalJob] = persistDeliveryJobs(
        state.storage.sql,
        createPendingDeliveryJobs(routing, [{ kind: "culture" }]),
        () => `01ORIG000000000000${String(sequence++).padStart(6, "0")}`,
        new Date("2026-05-04T00:00:00.000Z"),
        10_000,
      );
      assert(originalJob, "expected original delivery job");
      markDeliveryJobsFailed(
        state.storage.sql,
        [originalJob.id],
        1,
        10_000,
        10_000,
        new Error("permanent failure"),
        new Date("2026-05-04T00:00:20.000Z"),
      );
      markDeliveryJobsFailed(
        state.storage.sql,
        [originalJob.id],
        1,
        10_000,
        10_000,
        new Error("permanent failure"),
        new Date("2026-05-04T00:00:30.000Z"),
      );

      let redriveSequence = 0;
      const redrivenJob = redriveDeliveryJob(
        state.storage.sql,
        originalJob.id,
        () =>
          `01REDRIVE0000000000${String(redriveSequence++).padStart(6, "0")}`,
        new Date("2026-05-04T00:01:00.000Z"),
        5_000,
      );
      assert(redrivenJob, "expected redriven delivery job");

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
						ORDER BY created_at, id
					`,
        )
        .toArray();

      expect({
        redrivenJob,
        payloads: payloads.map((payload) => ({
          ...payload,
          body: JSON.parse(payload.body),
        })),
        deliveryJobs,
      }).toMatchObject({
        redrivenJob: {
          id: "01REDRIVE0000000000000001",
          payloadId: "01REDRIVE0000000000000000",
          destination: "OKAYAMA",
          payload: { kind: "culture" },
        },
        payloads: [
          {
            id: originalJob.payloadId,
            body: { kind: "culture" },
            created_at: "2026-05-04T00:00:00.000Z",
          },
          {
            id: "01REDRIVE0000000000000000",
            body: { kind: "culture" },
            created_at: "2026-05-04T00:01:00.000Z",
          },
        ],
        deliveryJobs: [
          {
            id: originalJob.id,
            payload_id: originalJob.payloadId,
            destination: "OKAYAMA",
            final_status: "failed",
            retry_count: 2,
          },
          {
            id: "01REDRIVE0000000000000001",
            payload_id: "01REDRIVE0000000000000000",
            destination: "OKAYAMA",
            created_at: "2026-05-04T00:01:00.000Z",
            final_status: null,
            finalized_at: null,
            retry_count: 0,
            last_failed_at: null,
            last_error: null,
            next_retry_at: "2026-05-04T00:01:05.000Z",
          },
        ],
      });
    });
  });

  test("returns null when the source job does not exist", async () => {
    const stub = getStub("store-redrive-missing-job");

    await runInDurableObject(stub, async (_instance, state) => {
      const redrivenJob = redriveDeliveryJob(
        state.storage.sql,
        "missing_job_id",
        () => "unused",
        new Date("2026-05-04T00:01:00.000Z"),
      );
      const payloads = state.storage.sql
        .exec<PayloadRow>("SELECT id FROM payloads")
        .toArray();
      const deliveryJobs = state.storage.sql
        .exec<DeliveryJobRow>("SELECT id FROM delivery_jobs")
        .toArray();

      expect({ redrivenJob, payloads, deliveryJobs }).toStrictEqual({
        redrivenJob: null,
        payloads: [],
        deliveryJobs: [],
      });
    });
  });

  test("keeps the redriven job after the original payload is ejected and evicted", async () => {
    // 1. Redrive a finalized delivery job into a new active payload/job.
    // 2. Eject and evict only the original finalized payload.
    // 3. Verify the redriven job remains deliverable without the original rows.
    const stub = getStub("store-redrive-survives-evict");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const [originalJob] = persistDeliveryJobs(
        state.storage.sql,
        createPendingDeliveryJobs(routing, [{ kind: "culture", version: 1 }]),
        () => `01ORIG000000000000${String(sequence++).padStart(6, "0")}`,
        new Date("2026-05-04T00:00:00.000Z"),
        10_000,
      );
      assert(originalJob, "expected original delivery job");
      markDeliveryJobsCompleted(
        state.storage.sql,
        [originalJob.id],
        new Date("2026-05-04T00:01:00.000Z"),
      );

      let redriveSequence = 0;
      const redrivenJob = redriveDeliveryJob(
        state.storage.sql,
        originalJob.id,
        () =>
          `01REDRIVE0000000000${String(redriveSequence++).padStart(6, "0")}`,
        new Date("2026-05-04T00:02:00.000Z"),
        10_000,
      );
      assert(redrivenJob, "expected redriven delivery job");

      const ejected = ejectPayloads(
        state.storage.sql,
        new Date("2026-05-04T00:01:30.000Z").getTime(),
        50,
        "01EJECT00000000000000000020",
      );
      evictEjection(state.storage.sql, "01EJECT00000000000000000020");

      const payloads = state.storage.sql
        .exec<PayloadRow>("SELECT id, body FROM payloads ORDER BY id")
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
      const deliverableJobs = listDeliverableJobs(
        state.storage.sql,
        10,
        new Date("2026-05-04T00:02:11.000Z"),
      );

      expect({
        ejected,
        payloads: payloads.map((payload) => ({
          id: payload.id,
          body: JSON.parse(payload.body),
        })),
        deliveryJobs,
        deliverableJobs,
      }).toMatchObject({
        ejected: { ejectKey: "01EJECT00000000000000000020" },
        payloads: [
          {
            id: redrivenJob.payloadId,
            body: { kind: "culture", version: 1 },
          },
        ],
        deliveryJobs: [
          {
            id: redrivenJob.id,
            payload_id: redrivenJob.payloadId,
            destination: "OKAYAMA",
            final_status: null,
            finalized_at: null,
            retry_count: 0,
          },
        ],
        deliverableJobs: [
          {
            id: redrivenJob.id,
            payloadId: redrivenJob.payloadId,
            destination: "OKAYAMA",
            payload: { kind: "culture", version: 1 },
          },
        ],
      });
    });
  });

  test("returns null when the source job has already been ejected", async () => {
    const stub = getStub("store-redrive-after-eject");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const [originalJob] = persistDeliveryJobs(
        state.storage.sql,
        createPendingDeliveryJobs(routing, [{ kind: "culture" }]),
        () => `01ORIG000000000000${String(sequence++).padStart(6, "0")}`,
        new Date("2026-05-04T00:00:00.000Z"),
        10_000,
      );
      assert(originalJob, "expected original delivery job");
      markDeliveryJobsCompleted(
        state.storage.sql,
        [originalJob.id],
        new Date("2026-05-04T00:01:00.000Z"),
      );
      ejectPayloads(
        state.storage.sql,
        new Date("2026-05-04T00:02:00.000Z").getTime(),
        50,
        "01EJECT00000000000000000021",
      );

      const redrivenJob = redriveDeliveryJob(
        state.storage.sql,
        originalJob.id,
        () => "unused",
        new Date("2026-05-04T00:03:00.000Z"),
      );

      expect(redrivenJob).toBeNull();
    });
  });
});

describe("list", () => {
  test("lists live payloads with delivery jobs and reported failures", async () => {
    // 1. Persist payloads with and without routed delivery jobs.
    // 2. Record a downstream failure for one job.
    // 3. Verify list returns payloads with their live delivery job state.
    const stub = getStub("store-list-live-payloads");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "culture", ordinal: 1 },
            { kind: "nature", ordinal: 2 },
            { kind: "other", ordinal: 3 },
          ]),
          () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
          new Date("2026-05-04T00:00:00.000Z"),
          10_000,
        ),
      );
      state.storage.transactionSync(() => {
        markDeliveryJobsCompleted(
          state.storage.sql,
          [jobs[0]?.id ?? ""],
          new Date("2026-05-04T00:01:00.000Z"),
        );
        recordDeliveryJobFailure(
          state.storage.sql,
          jobs[0]?.id ?? "",
          new Date("2026-05-04T00:02:00.000Z"),
        );
      });

      const page = state.storage.transactionSync(() =>
        list(state.storage.sql, undefined, 50, 262_144),
      );

      expect(page).toMatchObject({
        payloads: [
          {
            payload: { kind: "culture", ordinal: 1 },
            deliveryJobs: [
              {
                finalStatus: "completed",
                failureReportedAt: "2026-05-04T00:02:00.000Z",
              },
            ],
          },
          {
            payload: { kind: "nature", ordinal: 2 },
            deliveryJobs: [
              { destination: "HOKKAIDO", failureReportedAt: null },
              { destination: "OKINAWA", failureReportedAt: null },
            ],
          },
          {
            payload: { kind: "other", ordinal: 3 },
            deliveryJobs: [],
          },
        ],
      });
      expect(page.cursor).toBeUndefined();
    });
  });

  test("continues live payload pagination by cursor", async () => {
    const stub = getStub("store-list-live-cursor-pages");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      state.storage.transactionSync(() => {
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "other", ordinal: 1 },
            { kind: "other", ordinal: 2 },
            { kind: "other", ordinal: 3 },
          ]),
          () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
          new Date("2026-05-04T00:00:00.000Z"),
          10_000,
        );
      });

      const firstPage = state.storage.transactionSync(() =>
        list(state.storage.sql, undefined, 2, 262_144),
      );
      const secondPage = state.storage.transactionSync(() =>
        list(state.storage.sql, firstPage.cursor, 2, 262_144),
      );

      expect({
        firstPayloads: firstPage.payloads.map(({ payload }) => payload),
        secondPayloads: secondPage.payloads.map(({ payload }) => payload),
      }).toStrictEqual({
        firstPayloads: [
          { kind: "other", ordinal: 1 },
          { kind: "other", ordinal: 2 },
        ],
        secondPayloads: [{ kind: "other", ordinal: 3 }],
      });
      expect(firstPage.cursor).toEqual(expect.any(String));
      expect(secondPage.cursor).toBeUndefined();
    });
  });

  test("lists live payloads by creation time descending", async () => {
    const stub = getStub("store-list-live-desc");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      state.storage.transactionSync(() => {
        for (const ordinal of [1, 2, 3]) {
          persistDeliveryJobs(
            state.storage.sql,
            createPendingDeliveryJobs(routing, [{ kind: "other", ordinal }]),
            () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
            new Date(`2026-05-04T00:0${ordinal}:00.000Z`),
            10_000,
          );
        }
      });

      const firstPage = state.storage.transactionSync(() =>
        list(state.storage.sql, undefined, 2, 262_144, "desc"),
      );
      const secondPage = state.storage.transactionSync(() =>
        list(state.storage.sql, firstPage.cursor, 2, 262_144, "desc"),
      );

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
  });

  test("rejects an invalid live payload cursor", async () => {
    const stub = getStub("store-list-live-invalid-cursor");

    await runInDurableObject(stub, async (_instance, state) => {
      expect(() =>
        state.storage.transactionSync(() =>
          list(state.storage.sql, "not-base64", 50, 262_144),
        ),
      ).toThrow("eventhub: invalid cursor");
    });
  });
});

describe("ejectPayloads", () => {
  test("creates a singleton ejection snapshot for finalized payloads before the cutoff", async () => {
    // 1. Seed finalized, recently finalized, and still-active payloads.
    // 2. Eject by cutoff and verify only the older finalized payloads are snapshotted.
    // 3. Verify the snapshot metadata is persisted as a singleton ejection.
    const stub = getStub("store-eject-payloads");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const createdJobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
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
          createPendingDeliveryJobs(routing, [
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
          createPendingDeliveryJobs(routing, [
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
          "01EJECT00000000000000000000",
        ),
      );
      const listed = state.storage.transactionSync(() =>
        listEjected(state.storage.sql, "01EJECT00000000000000000000"),
      );

      const ejections = state.storage.sql
        .exec<EjectionRow>("SELECT key, before_at FROM ejections")
        .toArray();
      expect({
        ejected,
        listed,
        ejections,
      }).toMatchObject({
        ejected: {
          ejectKey: "01EJECT00000000000000000000",
        },
        listed: {
          payloads: [
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
          ],
        },
        ejections: [
          {
            key: "01EJECT00000000000000000000",
            before_at: "2026-05-05T00:00:00.000Z",
          },
        ],
      });
      expect(listed.cursor).toBeUndefined();
    });
  });

  test("removes ejected payloads and retains non-ejected rows", async () => {
    // 1. Seed payloads that should be ejected plus rows that must remain in source tables.
    // 2. Eject by cutoff.
    // 3. Verify only non-ejected payloads and their jobs remain in the live tables.
    const stub = getStub("store-eject-removes-source-rows");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const createdJobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
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
          createPendingDeliveryJobs(routing, [
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
          createPendingDeliveryJobs(routing, [
            { kind: "culture", avoidUrban: false },
          ]),
          () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
          new Date("2026-05-06T00:00:00.000Z"),
          10_000,
        );
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          50,
          "01EJECT00000000000000000005",
        );
      });

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

  test("returns the existing ejection while it remains un-evicted", async () => {
    const stub = getStub("store-eject-payloads-max");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
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
          "01EJECT00000000000000000001",
        ),
      );
      const repeated = state.storage.transactionSync(() =>
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-06T00:00:00.000Z").getTime(),
          50,
          "01EJECT00000000000000000002",
        ),
      );

      expect(ejected).toStrictEqual({
        ejectKey: "01EJECT00000000000000000001",
      });
      expect(repeated).toStrictEqual(ejected);
    });
  });

  test("limits a page by max when more rows remain", async () => {
    const stub = getStub("store-list-ejected-max");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "nature", ordinal: 1 },
            { kind: "nature", ordinal: 2 },
            { kind: "nature", ordinal: 3 },
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
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          3,
          "01EJECT00000000000000000006",
        );
      });

      const firstPage = state.storage.transactionSync(() =>
        listEjected(
          state.storage.sql,
          "01EJECT00000000000000000006",
          undefined,
          1,
          262_144,
        ),
      );
      expect(firstPage.payloads.map(({ payload }) => payload)).toStrictEqual([
        { kind: "nature", ordinal: 1 },
      ]);
      expect(firstPage.cursor).toEqual(expect.any(String));
    });
  });

  test("limits a page by maxBytes when the next item would overflow", async () => {
    const stub = getStub("store-list-ejected-max-bytes");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "nature", blob: "a".repeat(100) },
            { kind: "nature", blob: "b".repeat(100) },
            { kind: "nature", blob: "c".repeat(100) },
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
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          3,
          "01EJECT00000000000000000007",
        );
      });

      const firstPage = state.storage.transactionSync(() =>
        listEjected(
          state.storage.sql,
          "01EJECT00000000000000000007",
          undefined,
          3,
          250,
        ),
      );
      expect(firstPage.payloads.map(({ payload }) => payload)).toStrictEqual([
        { kind: "nature", blob: "a".repeat(100) },
      ]);
      expect(firstPage.cursor).toEqual(expect.any(String));
    });
  });

  test("continues pagination across multiple pages by cursor", async () => {
    const stub = getStub("store-list-ejected-cursor-pages");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "nature", ordinal: 1 },
            { kind: "nature", ordinal: 2 },
            { kind: "nature", ordinal: 3 },
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
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          3,
          "01EJECT00000000000000000008",
        );
      });

      const firstPage = state.storage.transactionSync(() =>
        listEjected(
          state.storage.sql,
          "01EJECT00000000000000000008",
          undefined,
          1,
        ),
      );
      const secondPage = state.storage.transactionSync(() =>
        listEjected(
          state.storage.sql,
          "01EJECT00000000000000000008",
          firstPage.cursor,
          1,
        ),
      );
      const thirdPage = state.storage.transactionSync(() =>
        listEjected(
          state.storage.sql,
          "01EJECT00000000000000000008",
          secondPage.cursor,
          1,
        ),
      );

      expect(firstPage.payloads.map(({ payload }) => payload)).toStrictEqual([
        { kind: "nature", ordinal: 1 },
      ]);
      expect(secondPage.payloads.map(({ payload }) => payload)).toStrictEqual([
        { kind: "nature", ordinal: 2 },
      ]);
      expect(thirdPage.payloads.map(({ payload }) => payload)).toStrictEqual([
        { kind: "nature", ordinal: 3 },
      ]);
      expect(firstPage.cursor).toEqual(expect.any(String));
      expect(secondPage.cursor).toEqual(expect.any(String));
      expect(thirdPage.cursor).toBeUndefined();
    });
  });

  test("returns an oversized first item even when it exceeds maxBytes", async () => {
    const stub = getStub("store-list-ejected-pages");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "culture", blob: "x".repeat(140_000) },
            { kind: "nature", ordinal: 1 },
            { kind: "nature", ordinal: 2 },
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
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          3,
          "01EJECT00000000000000000004",
        );
      });

      const firstPage = state.storage.transactionSync(() =>
        listEjected(
          state.storage.sql,
          "01EJECT00000000000000000004",
          undefined,
          2,
          1,
        ),
      );
      expect(firstPage.payloads.map(({ payload }) => payload)).toStrictEqual([
        { kind: "culture", blob: "x".repeat(140_000) },
      ]);
      expect(firstPage.cursor).toEqual(expect.any(String));
    });
  });

  test("returns all rows when maxBytes matches the page exactly", async () => {
    const stub = getStub("store-list-ejected-max-bytes-equal");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [{ kind: "nature", blob: "z" }]),
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
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          1,
          "01EJECT00000000000000000009",
        );
      });

      const rows = state.storage.sql
        .exec<{ total: number }>(
          `
						SELECT
							octet_length(ep.body) AS total
						FROM ejected_payloads ep
						WHERE ep.ejection_key = ?
					`,
          "01EJECT00000000000000000009",
        )
        .toArray();
      const page = state.storage.transactionSync(() =>
        listEjected(
          state.storage.sql,
          "01EJECT00000000000000000009",
          undefined,
          1,
          // biome-ignore lint/style/noNonNullAssertion: test
          rows[0]!.total,
        ),
      );

      expect(page.payloads.map(({ payload }) => payload)).toStrictEqual([
        { kind: "nature", blob: "z" },
      ]);
      expect(page.cursor).toBeUndefined();
    });
  });

  test("reports UTF-8 body sizes with octet_length", async () => {
    // 1. Seed ejected rows containing both multi-byte and ASCII payload bodies.
    // 2. Read their stored bodies and byte sizes from SQLite.
    // 3. Verify octet_length matches the UTF-8 byte count computed in the test.
    const stub = getStub("store-list-ejected-octet-length");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "nature", note: "界" },
            { kind: "nature", note: "a" },
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
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          2,
          "01EJECT00000000000000000010",
        );
      });

      const rows = state.storage.sql
        .exec<{ body: string; total: number }>(
          `
						SELECT
							ep.body,
							octet_length(ep.body) AS total
						FROM ejected_payloads ep
						WHERE ep.ejection_key = ?
						ORDER BY ep.created_at ASC, ep.payload_id ASC
					`,
          "01EJECT00000000000000000010",
        )
        .toArray();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.total)).toStrictEqual(
        rows.map((row) => new TextEncoder().encode(row.body).length),
      );
    });
  });

  test("uses UTF-8 byte size when enforcing maxBytes", async () => {
    // 1. Seed ejected rows containing both multi-byte and ASCII payload bodies.
    // 2. Read their byte sizes from SQLite.
    // 3. Set maxBytes between the first and second rows so only byte-accurate paging keeps one row.
    const stub = getStub("store-list-ejected-max-bytes-utf8");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "nature", note: "界" },
            { kind: "nature", note: "a" },
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
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          2,
          "01EJECT00000000000000000010",
        );
      });

      const rows = state.storage.sql
        .exec<{ total: number }>(
          `
						SELECT
							octet_length(ep.body) AS total
						FROM ejected_payloads ep
						WHERE ep.ejection_key = ?
						ORDER BY ep.created_at ASC, ep.payload_id ASC
					`,
          "01EJECT00000000000000000010",
        )
        .toArray();

      const page = state.storage.transactionSync(() =>
        listEjected(
          state.storage.sql,
          "01EJECT00000000000000000010",
          undefined,
          2,
          // The first payload fits, but adding the second should overflow only if byte length is used.
          // biome-ignore lint/style/noNonNullAssertion: test
          rows[0]!.total + rows[1]!.total - 1,
        ),
      );

      expect(page.payloads.map(({ payload }) => payload)).toStrictEqual([
        { kind: "nature", note: "界" },
      ]);
      expect(page.cursor).toEqual(expect.any(String));
    });
  });

  test("rejects an invalid cursor", async () => {
    const stub = getStub("store-list-ejected-invalid-cursor");

    await runInDurableObject(stub, async (_instance, state) => {
      expect(() =>
        state.storage.transactionSync(() =>
          listEjected(
            state.storage.sql,
            "01EJECT00000000000000000000",
            "not-base64",
          ),
        ),
      ).toThrow("eventhub: invalid cursor");
    });
  });

  test("evicts an active ejection idempotently", async () => {
    const stub = getStub("store-evict-ejection");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
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
          jobs.map((job) => job.id),
          new Date("2026-05-04T00:01:00.000Z"),
        );
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          50,
          "01EJECT00000000000000000003",
        );
        evictEjection(state.storage.sql, "01EJECT00000000000000000003");
        evictEjection(state.storage.sql, "01EJECT00000000000000000003");
      });

      expect(
        state.storage.sql.exec("SELECT key FROM ejections").toArray(),
      ).toStrictEqual([]);
      expect(
        state.storage.sql
          .exec("SELECT payload_id FROM ejected_payloads")
          .toArray(),
      ).toStrictEqual([]);
      expect(
        state.storage.sql
          .exec("SELECT id FROM ejected_delivery_jobs")
          .toArray(),
      ).toStrictEqual([]);
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
          createPendingDeliveryJobs(routing, [
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
          createPendingDeliveryJobs(routing, [
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
          createPendingDeliveryJobs(routing, [
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
          createPendingDeliveryJobs(routing, [
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
          createPendingDeliveryJobs(routing, [
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
          createPendingDeliveryJobs(routing, [
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
          createPendingDeliveryJobs(routing, [
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

describe("recordDeliveryJobFailure", () => {
  test("records a failure for the first time", async () => {
    // 1. Persist a delivery job.
    // 2. Record a failure for that job.
    // 3. Verify the failure was recorded.
    const stub = getStub("record-failure-first-time");

    await runInDurableObject(stub, (_instance, state) => {
      const pendingDeliveryJobs = createPendingDeliveryJobs(routing, [
        { kind: "culture" },
      ]);
      const jobs = persistDeliveryJobs(
        state.storage.sql,
        pendingDeliveryJobs,
        vi.fn().mockReturnValue("job_001"),
        new Date("2026-05-04T00:00:00.000Z"),
      );

      const recorded = recordDeliveryJobFailure(
        state.storage.sql,
        jobs[0]?.id ?? "",
        new Date("2026-05-04T00:00:10.000Z"),
      );

      const failures = state.storage.sql
        .exec<{
          delivery_job_id: string;
          reported_at: string;
        }>("SELECT delivery_job_id, reported_at FROM delivery_job_failures")
        .toArray();

      expect(recorded).toBe(true);
      expect(failures).toStrictEqual([
        {
          delivery_job_id: jobs[0]?.id,
          reported_at: "2026-05-04T00:00:10.000Z",
        },
      ]);
    });
  });

  test("is idempotent when a failure is already recorded", async () => {
    // 1. Persist a delivery job and record a failure.
    // 2. Attempt to record another failure for the same job.
    // 3. Verify the timestamp remains unchanged.
    const stub = getStub("record-failure-idempotent");

    await runInDurableObject(stub, (_instance, state) => {
      const pendingDeliveryJobs = createPendingDeliveryJobs(routing, [
        { kind: "culture" },
      ]);
      const jobs = persistDeliveryJobs(
        state.storage.sql,
        pendingDeliveryJobs,
        vi.fn().mockReturnValue("job_002"),
        new Date("2026-05-04T00:00:00.000Z"),
      );

      const firstRecorded = recordDeliveryJobFailure(
        state.storage.sql,
        jobs[0]?.id ?? "",
        new Date("2026-05-04T00:00:10.000Z"),
      );
      const secondRecorded = recordDeliveryJobFailure(
        state.storage.sql,
        jobs[0]?.id ?? "",
        new Date("2026-05-04T00:00:20.000Z"),
      );

      const failures = state.storage.sql
        .exec<{
          delivery_job_id: string;
          reported_at: string;
        }>("SELECT delivery_job_id, reported_at FROM delivery_job_failures")
        .toArray();

      expect({ firstRecorded, secondRecorded }).toStrictEqual({
        firstRecorded: true,
        secondRecorded: false,
      });
      expect(failures).toStrictEqual([
        {
          delivery_job_id: jobs[0]?.id,
          reported_at: "2026-05-04T00:00:10.000Z",
        },
      ]);
    });
  });

  test("records failures for multiple distinct jobs", async () => {
    // 1. Persist multiple delivery jobs.
    // 2. Record failures for each job.
    // 3. Verify all failures are recorded independently.
    const stub = getStub("record-multiple-failures");

    await runInDurableObject(stub, (_instance, state) => {
      const pendingDeliveryJobs = createPendingDeliveryJobs(routing, [
        { kind: "culture" },
        { kind: "nature" },
      ]);
      const jobs = persistDeliveryJobs(
        state.storage.sql,
        pendingDeliveryJobs,
        (() => {
          let counter = 0;
          return () => `job_${String(counter++).padStart(3, "0")}`;
        })(),
        new Date("2026-05-04T00:00:00.000Z"),
      );

      const recorded = [
        recordDeliveryJobFailure(
          state.storage.sql,
          jobs[0]?.id ?? "",
          new Date("2026-05-04T00:00:10.000Z"),
        ),
        recordDeliveryJobFailure(
          state.storage.sql,
          jobs[1]?.id ?? "",
          new Date("2026-05-04T00:00:15.000Z"),
        ),
        recordDeliveryJobFailure(
          state.storage.sql,
          jobs[2]?.id ?? "",
          new Date("2026-05-04T00:00:20.000Z"),
        ),
      ];

      const failures = state.storage.sql
        .exec<{
          delivery_job_id: string;
          reported_at: string;
        }>(
          "SELECT delivery_job_id, reported_at FROM delivery_job_failures ORDER BY reported_at",
        )
        .toArray();

      expect(recorded).toStrictEqual([true, true, true]);
      expect(failures).toStrictEqual([
        {
          delivery_job_id: jobs[0]?.id,
          reported_at: "2026-05-04T00:00:10.000Z",
        },
        {
          delivery_job_id: jobs[1]?.id,
          reported_at: "2026-05-04T00:00:15.000Z",
        },
        {
          delivery_job_id: jobs[2]?.id,
          reported_at: "2026-05-04T00:00:20.000Z",
        },
      ]);
    });
  });

  test("is a no-op when delivery job does not exist", async () => {
    // 1. Attempt to record a failure for a non-existent delivery job.
    // 2. Verify no failure record is created and no error is thrown.
    const stub = getStub("record-failure-missing-job");

    await runInDurableObject(stub, (_instance, state) => {
      const recorded = recordDeliveryJobFailure(
        state.storage.sql,
        "nonexistent_job_id",
        new Date("2026-05-04T00:00:10.000Z"),
      );

      const failures = state.storage.sql
        .exec<{
          delivery_job_id: string;
          reported_at: string;
        }>("SELECT delivery_job_id, reported_at FROM delivery_job_failures")
        .toArray();

      expect(recorded).toBe(false);
      expect(failures).toStrictEqual([]);
    });
  });

  test("is a no-op when delivery job has been ejected", async () => {
    // 1. Persist a delivery job, complete it, and eject it.
    // 2. Attempt to record a failure after ejection.
    // 3. Verify no failure record is created.
    const stub = getStub("record-failure-after-eject");

    await runInDurableObject(stub, async (_instance, state) => {
      const pendingDeliveryJobs = createPendingDeliveryJobs(routing, [
        { kind: "culture" },
      ]);
      const jobs = persistDeliveryJobs(
        state.storage.sql,
        pendingDeliveryJobs,
        vi.fn().mockReturnValue("01TEST00000000000000001"),
        new Date("2026-05-04T00:00:00.000Z"),
        10_000,
      );

      const jobId = jobs[0]?.id ?? "";

      // Complete the job so it can be ejected
      markDeliveryJobsCompleted(
        state.storage.sql,
        [jobId],
        new Date("2026-05-04T00:00:01.000Z"),
      );

      // Eject the job
      ejectPayloads(
        state.storage.sql,
        new Date("2026-05-04T00:00:02.000Z").getTime(),
        50,
        "ejection_001",
      );

      // Attempt to record failure after ejection
      const recorded = recordDeliveryJobFailure(
        state.storage.sql,
        jobId,
        new Date("2026-05-04T00:00:10.000Z"),
      );

      const failures = state.storage.sql
        .exec<{
          delivery_job_id: string;
          reported_at: string;
        }>("SELECT delivery_job_id, reported_at FROM delivery_job_failures")
        .toArray();

      expect(recorded).toBe(false);
      expect(failures).toStrictEqual([]);
    });
  });
});

describe("eject and evict with delivery job failures", () => {
  test("copies delivery job failures when ejecting payloads", async () => {
    // 1. Create delivery jobs and report failures for some of them.
    // 2. Eject the payloads.
    // 3. Verify that failure records are copied to ejected_delivery_job_failures.
    const stub = getStub("eject-with-failures");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "culture", avoidUrban: true },
            { kind: "nature", avoidUrban: false },
          ]),
          () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
          new Date("2026-05-04T00:00:00.000Z"),
          10_000,
        ),
      );

      state.storage.transactionSync(() => {
        // Report failures for some jobs
        recordDeliveryJobFailure(
          state.storage.sql,
          jobs[0]?.id ?? "",
          new Date("2026-05-04T00:05:00.000Z"),
        );
        recordDeliveryJobFailure(
          state.storage.sql,
          jobs[2]?.id ?? "",
          new Date("2026-05-04T00:10:00.000Z"),
        );

        // Mark all jobs as completed
        markDeliveryJobsCompleted(
          state.storage.sql,
          jobs.map((job) => job.id),
          new Date("2026-05-04T00:20:00.000Z"),
        );

        // Eject the payloads
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          50,
          "01EJECT00000000000000000010",
        );
      });

      const ejectedFailures = state.storage.sql
        .exec<{
          ejection_key: string;
          delivery_job_id: string;
          reported_at: string;
        }>(
          "SELECT ejection_key, delivery_job_id, reported_at FROM ejected_delivery_job_failures ORDER BY reported_at",
        )
        .toArray();

      expect(ejectedFailures).toStrictEqual([
        {
          ejection_key: "01EJECT00000000000000000010",
          delivery_job_id: jobs[0]?.id,
          reported_at: "2026-05-04T00:05:00.000Z",
        },
        {
          ejection_key: "01EJECT00000000000000000010",
          delivery_job_id: jobs[2]?.id,
          reported_at: "2026-05-04T00:10:00.000Z",
        },
      ]);

      // Verify original failure records are deleted
      const remainingFailures = state.storage.sql
        .exec<{
          delivery_job_id: string;
        }>("SELECT delivery_job_id FROM delivery_job_failures")
        .toArray();

      expect(remainingFailures).toStrictEqual([]);
    });
  });

  test("includes failure information in listEjected results", async () => {
    // 1. Create delivery jobs and report failures for some of them.
    // 2. Eject the payloads.
    // 3. Use listEjected and verify the failure information is included.
    const stub = getStub("list-ejected-with-failures");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "culture", avoidUrban: true },
          ]),
          () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
          new Date("2026-05-04T00:00:00.000Z"),
          10_000,
        ),
      );

      state.storage.transactionSync(() => {
        // Report failure for the job
        recordDeliveryJobFailure(
          state.storage.sql,
          jobs[0]?.id ?? "",
          new Date("2026-05-04T00:05:00.000Z"),
        );

        // Mark job as completed
        markDeliveryJobsCompleted(
          state.storage.sql,
          jobs.map((job) => job.id),
          new Date("2026-05-04T00:20:00.000Z"),
        );

        // Eject the payloads
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          50,
          "01EJECT00000000000000000011",
        );
      });

      const result = state.storage.transactionSync(() =>
        listEjected(
          state.storage.sql,
          "01EJECT00000000000000000011",
          undefined,
          50,
        ),
      );

      expect(result.payloads).toHaveLength(1);
      expect(result.payloads[0]?.deliveryJobs).toHaveLength(1);
      expect(result.payloads[0]?.deliveryJobs[0]).toMatchObject({
        id: jobs[0]?.id,
        failureReportedAt: "2026-05-04T00:05:00.000Z",
      });
    });
  });

  test("includes null failure information when no failure was reported", async () => {
    // 1. Create a delivery job without reporting failure.
    // 2. Eject the payload.
    // 3. Verify that failureReportedAt is null in listEjected.
    const stub = getStub("list-ejected-without-failures");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "culture", avoidUrban: true },
          ]),
          () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
          new Date("2026-05-04T00:00:00.000Z"),
          10_000,
        ),
      );

      state.storage.transactionSync(() => {
        // Mark job as completed without reporting failure
        markDeliveryJobsCompleted(
          state.storage.sql,
          jobs.map((job) => job.id),
          new Date("2026-05-04T00:20:00.000Z"),
        );

        // Eject the payloads
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          50,
          "01EJECT00000000000000000012",
        );
      });

      const result = state.storage.transactionSync(() =>
        listEjected(
          state.storage.sql,
          "01EJECT00000000000000000012",
          undefined,
          50,
        ),
      );

      expect(result.payloads).toHaveLength(1);
      expect(result.payloads[0]?.deliveryJobs).toHaveLength(1);
      expect(result.payloads[0]?.deliveryJobs[0]).toMatchObject({
        id: jobs[0]?.id,
        failureReportedAt: null,
      });
    });
  });

  test("deletes ejected failure records when evicting", async () => {
    // 1. Create delivery jobs, report failures, and eject.
    // 2. Evict the ejection.
    // 3. Verify that ejected_delivery_job_failures records are deleted.
    const stub = getStub("evict-with-failures");

    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "culture", avoidUrban: true },
          ]),
          () => `01TEST000000000000${String(sequence++).padStart(6, "0")}`,
          new Date("2026-05-04T00:00:00.000Z"),
          10_000,
        ),
      );

      state.storage.transactionSync(() => {
        // Report failure
        recordDeliveryJobFailure(
          state.storage.sql,
          jobs[0]?.id ?? "",
          new Date("2026-05-04T00:05:00.000Z"),
        );

        // Mark job as completed
        markDeliveryJobsCompleted(
          state.storage.sql,
          jobs.map((job) => job.id),
          new Date("2026-05-04T00:20:00.000Z"),
        );

        // Eject and then evict
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          50,
          "01EJECT00000000000000000013",
        );

        evictEjection(state.storage.sql, "01EJECT00000000000000000013");
      });

      const ejectedFailures = state.storage.sql
        .exec<{
          delivery_job_id: string;
        }>("SELECT delivery_job_id FROM ejected_delivery_job_failures")
        .toArray();

      expect(ejectedFailures).toStrictEqual([]);
    });
  });
});

describe("automatic eviction store operations", () => {
  test("getNextEvictionBaseline uses created_at for a payload without jobs", async () => {
    const stub = getStub("eviction-baseline-jobless");
    await runInDurableObject(stub, async (_instance, state) => {
      const createdAt = new Date("2026-05-04T00:00:00.000Z");
      state.storage.transactionSync(() => {
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [{ kind: "other" }]),
          () => "01BASELINEJOBLESS000000000",
          createdAt,
        );
      });

      expect(getNextEvictionBaseline(state.storage.sql)).toBe(
        createdAt.toISOString(),
      );
    });
  });

  test("getNextEvictionBaseline uses the latest finalization and excludes pending jobs", async () => {
    // 1. Seed a two-destination payload and a separate pending payload.
    // 2. Finalize both jobs at different times.
    // 3. Verify the finalized payload uses its latest finalized_at timestamp.
    const stub = getStub("eviction-baseline-finalized");
    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const finalizedJobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [{ kind: "nature" }]),
          () => `01BASELINEFINAL${String(sequence++).padStart(10, "0")}`,
          new Date("2026-05-01T00:00:00.000Z"),
        ),
      );
      state.storage.transactionSync(() => {
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [{ kind: "culture" }]),
          () => `01BASELINEPEND${String(sequence++).padStart(11, "0")}`,
          new Date("2026-04-01T00:00:00.000Z"),
        );
        markDeliveryJobsCompleted(
          state.storage.sql,
          [finalizedJobs[0]?.id ?? ""],
          new Date("2026-05-02T00:00:00.000Z"),
        );
        markDeliveryJobsCompleted(
          state.storage.sql,
          [finalizedJobs[1]?.id ?? ""],
          new Date("2026-05-03T00:00:00.000Z"),
        );
      });

      expect(getNextEvictionBaseline(state.storage.sql)).toBe(
        "2026-05-03T00:00:00.000Z",
      );
    });
  });

  test("deleteEvictionCandidates deletes a stable bounded batch and related rows", async () => {
    // 1. Seed an old jobless payload, an old finalized payload with a failure,
    //    an old pending payload, and a new jobless payload.
    // 2. Delete one candidate and verify the oldest baseline wins.
    // 3. Delete the remaining eligible candidate and verify related rows only.
    const stub = getStub("delete-eviction-candidates");
    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      state.storage.transactionSync(() => {
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "other", marker: "old-jobless" },
          ]),
          () => `01DELETESTORE${String(sequence++).padStart(12, "0")}`,
          new Date("2026-05-01T00:00:00.000Z"),
        );
      });
      const finalizedJobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "culture", marker: "finalized" },
          ]),
          () => `01DELETESTORE${String(sequence++).padStart(12, "0")}`,
          new Date("2026-05-01T01:00:00.000Z"),
        ),
      );
      state.storage.transactionSync(() => {
        markDeliveryJobsCompleted(
          state.storage.sql,
          finalizedJobs.map(({ id }) => id),
          new Date("2026-05-01T02:00:00.000Z"),
        );
        recordDeliveryJobFailure(
          state.storage.sql,
          finalizedJobs[0]?.id ?? "",
          new Date("2026-05-01T03:00:00.000Z"),
        );
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "culture", marker: "pending" },
          ]),
          () => `01DELETESTORE${String(sequence++).padStart(12, "0")}`,
          new Date("2026-04-01T00:00:00.000Z"),
        );
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [
            { kind: "other", marker: "new-jobless" },
          ]),
          () => `01DELETESTORE${String(sequence++).padStart(12, "0")}`,
          new Date("2026-05-06T00:00:00.000Z"),
        );
      });

      const firstDeleted = state.storage.transactionSync(() =>
        deleteEvictionCandidates(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          1,
        ),
      );
      expect({
        firstDeleted,
        markers: state.storage.sql
          .exec<{ body: string }>("SELECT body FROM payloads ORDER BY id")
          .toArray()
          .map(({ body }) => JSON.parse(body).marker),
      }).toStrictEqual({
        firstDeleted: 1,
        markers: ["finalized", "pending", "new-jobless"],
      });

      const secondDeleted = state.storage.transactionSync(() =>
        deleteEvictionCandidates(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          10,
        ),
      );
      expect({
        secondDeleted,
        markers: state.storage.sql
          .exec<{ body: string }>("SELECT body FROM payloads ORDER BY id")
          .toArray()
          .map(({ body }) => JSON.parse(body).marker),
        failures: state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM delivery_job_failures",
          )
          .one().count,
        candidates: state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM automatic_eviction_candidates",
          )
          .one().count,
        snapshots: state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM ejections")
          .one().count,
      }).toStrictEqual({
        secondDeleted: 1,
        markers: ["pending", "new-jobless"],
        failures: 0,
        candidates: 0,
        snapshots: 0,
      });
    });
  });

  test("createAutomaticEjection registers ownership and immutable archive metadata", async () => {
    // 1. Seed one eligible payload and create an automatic ejection atomically.
    // 2. Verify run mapping, ownership, prefix, object identity, and timestamps.
    const stub = getStub("create-automatic-ejection");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.transactionSync(() => {
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [{ kind: "other" }]),
          () => "01AUTOMATICPAYLOAD00000000",
          new Date("2026-05-01T00:00:00.000Z"),
        );
      });
      const now = new Date("2026-05-06T00:00:00.000Z");
      const cutoff = new Date("2026-05-05T00:00:00.000Z");
      const run = state.storage.transactionSync(() =>
        createAutomaticEjection(
          state.storage.sql,
          cutoff.getTime(),
          50,
          "01AUTOMATICEJECTION0000000",
          "production/events",
          "object-id",
          "object-name",
          now,
        ),
      );

      expect({
        run,
        loaded: getEvictionRun(state.storage.sql),
        active: getActiveEjection(state.storage.sql),
      }).toMatchObject({
        run: {
          ejectionKey: "01AUTOMATICEJECTION0000000",
          phase: "pages",
          cursor: null,
          pageIndex: 0,
          payloadCount: 0,
          archivePrefix: "production/events",
          objectId: "object-id",
          objectName: "object-name",
          cutoff: cutoff.toISOString(),
          createdAt: now.toISOString(),
          nextAttemptAt: now.toISOString(),
          retryCount: 0,
        },
        loaded: { ejectionKey: "01AUTOMATICEJECTION0000000" },
        active: {
          ejectKey: "01AUTOMATICEJECTION0000000",
          automatic: true,
        },
      });
    });
  });

  test("getActiveEjection distinguishes a manual snapshot from automatic ownership", async () => {
    // 1. Create a manual snapshot.
    // 2. Verify it is not marked automatic and an automatic run cannot claim it.
    const stub = getStub("manual-ejection-ownership");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.transactionSync(() => {
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [{ kind: "other" }]),
          () => "01MANUALOWNERSHIP000000000",
          new Date("2026-05-01T00:00:00.000Z"),
        );
        ejectPayloads(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          50,
          "01MANUALOWNERSHIPEJECTION00",
          new Date("2026-05-06T00:00:00.000Z"),
        );
      });

      const automatic = state.storage.transactionSync(() =>
        createAutomaticEjection(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          50,
          "01SHOULDNOTCLAIMMANUAL00000",
          "archive",
          "object-id",
          undefined,
          new Date("2026-05-06T00:01:00.000Z"),
        ),
      );
      expect({
        active: getActiveEjection(state.storage.sql),
        automatic,
        run: getEvictionRun(state.storage.sql),
      }).toStrictEqual({
        active: {
          ejectKey: "01MANUALOWNERSHIPEJECTION00",
          automatic: false,
        },
        automatic: null,
        run: null,
      });
    });
  });

  test("advanceEvictionPage persists cursor progress and stable completion time", async () => {
    // 1. Create an automatic run and advance a non-final page.
    // 2. Advance its final page and verify the manifest phase and completed_at.
    const stub = getStub("advance-eviction-page");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.transactionSync(() => {
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [{ kind: "other" }]),
          () => "01ADVANCEPAYLOAD0000000000",
          new Date("2026-05-01T00:00:00.000Z"),
        );
        createAutomaticEjection(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          50,
          "01ADVANCEEJECTION000000000",
          "archive",
          "object-id",
          undefined,
          new Date("2026-05-06T00:00:00.000Z"),
        );
        advanceEvictionPage(
          state.storage.sql,
          "01ADVANCEEJECTION000000000",
          "next-cursor",
          3,
          new Date("2026-05-06T00:01:00.000Z"),
        );
      });
      expect(getEvictionRun(state.storage.sql)).toMatchObject({
        phase: "pages",
        cursor: "next-cursor",
        pageIndex: 1,
        payloadCount: 3,
        completedAt: null,
      });

      state.storage.transactionSync(() => {
        advanceEvictionPage(
          state.storage.sql,
          "01ADVANCEEJECTION000000000",
          undefined,
          2,
          new Date("2026-05-06T00:02:00.000Z"),
        );
      });
      expect(getEvictionRun(state.storage.sql)).toMatchObject({
        phase: "manifest",
        cursor: null,
        pageIndex: 2,
        payloadCount: 5,
        completedAt: "2026-05-06T00:02:00.000Z",
        retryCount: 0,
        lastError: null,
      });
    });
  });

  test("recordEvictionFailure increments retries and caps exponential backoff", async () => {
    // 1. Create an automatic run.
    // 2. Record seven failures at the same time to reach the one-hour cap.
    // 3. Verify retry metadata reflects the latest failure and capped schedule.
    const stub = getStub("record-eviction-failure");
    await runInDurableObject(stub, async (_instance, state) => {
      const failedAt = new Date("2026-05-06T00:00:00.000Z");
      state.storage.transactionSync(() => {
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [{ kind: "other" }]),
          () => "01FAILRUNPAYLOAD0000000000",
          new Date("2026-05-01T00:00:00.000Z"),
        );
        createAutomaticEjection(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          50,
          "01FAILRUNEJECTION000000000",
          "archive",
          "object-id",
          undefined,
          failedAt,
        );
        for (let retry = 1; retry <= 7; retry += 1) {
          recordEvictionFailure(
            state.storage.sql,
            "01FAILRUNEJECTION000000000",
            new Error(`failure-${retry}`),
            failedAt,
          );
        }
      });

      expect(getEvictionRun(state.storage.sql)).toMatchObject({
        retryCount: 7,
        lastError: "failure-7",
        nextAttemptAt: "2026-05-06T01:00:00.000Z",
        updatedAt: failedAt.toISOString(),
      });
    });
  });

  test("completeAutomaticEviction removes the run and its entire snapshot", async () => {
    // 1. Create an automatic run containing a payload and delivery job.
    // 2. Complete it and verify all automatic snapshot tables are empty.
    const stub = getStub("complete-automatic-eviction");
    await runInDurableObject(stub, async (_instance, state) => {
      let sequence = 0;
      const jobs = state.storage.transactionSync(() =>
        persistDeliveryJobs(
          state.storage.sql,
          createPendingDeliveryJobs(routing, [{ kind: "culture" }]),
          () => `01COMPLETEAUTO${String(sequence++).padStart(11, "0")}`,
          new Date("2026-05-01T00:00:00.000Z"),
        ),
      );
      state.storage.transactionSync(() => {
        markDeliveryJobsCompleted(
          state.storage.sql,
          jobs.map(({ id }) => id),
          new Date("2026-05-02T00:00:00.000Z"),
        );
        createAutomaticEjection(
          state.storage.sql,
          new Date("2026-05-05T00:00:00.000Z").getTime(),
          50,
          "01COMPLETEEJECTION00000000",
          "archive",
          "object-id",
          undefined,
          new Date("2026-05-06T00:00:00.000Z"),
        );
        completeAutomaticEviction(
          state.storage.sql,
          "01COMPLETEEJECTION00000000",
        );
      });

      const counts = state.storage.sql
        .exec<{ table_name: string; row_count: number }>(`
			SELECT 'eviction_runs' AS table_name, COUNT(*) AS row_count FROM eviction_runs
			UNION ALL SELECT 'ejections', COUNT(*) FROM ejections
			UNION ALL SELECT 'ejected_payloads', COUNT(*) FROM ejected_payloads
			UNION ALL SELECT 'ejected_delivery_jobs', COUNT(*) FROM ejected_delivery_jobs
			UNION ALL SELECT 'ejected_delivery_job_failures', COUNT(*) FROM ejected_delivery_job_failures
		`)
        .toArray();
      expect(counts).toStrictEqual([
        { table_name: "eviction_runs", row_count: 0 },
        { table_name: "ejections", row_count: 0 },
        { table_name: "ejected_payloads", row_count: 0 },
        { table_name: "ejected_delivery_jobs", row_count: 0 },
        { table_name: "ejected_delivery_job_failures", row_count: 0 },
      ]);
      expect(getActiveEjection(state.storage.sql)).toBeNull();
      expect(getEvictionRun(state.storage.sql)).toBeNull();
    });
  });
});
