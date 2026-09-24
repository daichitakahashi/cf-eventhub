import { describe, expect, test, vi } from "vitest";

import type { Result } from "../errors";
import {
  deliverJobs,
  deliverPersistedJobs,
  resolveDeliveryJobs as resolveDeliveryJobsResult,
  resolveDestinationBindings,
  validatePendingQueueMessageSizes,
} from "./delivery";
import { QueueMock, R2BucketMock, WorkflowMock } from "./mock";
import { type Route, type RoutingStrategy, routeByConfig } from "./routing";
import {
  createPendingDeliveryJobs as createPendingDeliveryJobsResult,
  type PersistedDeliveryJob,
} from "./store";
import type { EventPayload } from "./type";

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  if (!("value" in result)) throw new Error("expected a result value");
  return result.value as T;
};

const createPendingDeliveryJobs = <Env extends object>(
  ...args: Parameters<typeof createPendingDeliveryJobsResult<Env>>
) => unwrap(createPendingDeliveryJobsResult(...args));
const resolveDeliveryJobs = <Env extends object>(
  ...args: Parameters<typeof resolveDeliveryJobsResult<Env>>
) => unwrap(resolveDeliveryJobsResult(...args));

const createEnv = () => ({
  OKAYAMA: new QueueMock(),
  HOKKAIDO: new QueueMock(),
  OKINAWA: new QueueMock(),
  ARCHIVE: new R2BucketMock() as unknown as R2Bucket,
});

type Env = ReturnType<typeof createEnv>;

const baseRoutes: Route<Env>[] = [
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
];

const createRouting = (env: Env) => routeByConfig(env, { routes: baseRoutes });

const createSubsetRouting = <T extends object>(env: T) =>
  routeByConfig(env as unknown as Env, {
    routes: baseRoutes,
  }) as unknown as RoutingStrategy<T>;

const noopOnDelivered = async (): Promise<void> => {};
const noopOnFailed = async (): Promise<void> => {};
const deliveryContext = {
  instanceId: "test-instance",
  includeDeliveryMetadata: false,
} as const;

const createPayloadWithJsonBytes = (bytes: number): EventPayload => {
  const payload = { kind: "culture", data: "" };
  const overhead = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  return { ...payload, data: "x".repeat(bytes - overhead) };
};

describe("resolveDestinationBindings", () => {
  test("reuses resolved destinations for validation and initial delivery", () => {
    const env = createEnv();
    const routing = createRouting(env);
    const resolveDestination = vi.spyOn(routing, "resolveDestination");
    const pendingDeliveryJobs = createPendingDeliveryJobs(routing, [
      { kind: "culture" },
    ]);

    const resolved = resolveDestinationBindings(routing, pendingDeliveryJobs);
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(
      validatePendingQueueMessageSizes(
        resolved.value,
        pendingDeliveryJobs,
        deliveryContext,
      ),
    ).toStrictEqual({ ok: true });
    resolveDeliveryJobs(
      routing,
      [
        {
          id: "01TEST00000000000000000001",
          payloadId: "01TEST00000000000000000000",
          destination: "OKAYAMA",
          payload: { kind: "culture" },
        },
      ],
      resolved.value,
    );

    expect(resolveDestination).toHaveBeenCalledTimes(1);
  });

  test("assigns a stable code to an oversized Queue payload", () => {
    const env = createEnv();
    const routing = createRouting(env);
    const pendingDeliveryJobs = createPendingDeliveryJobs(routing, [
      createPayloadWithJsonBytes(128_001),
    ]);
    const resolved = resolveDestinationBindings(routing, pendingDeliveryJobs);
    if (!resolved.ok) throw new Error(resolved.error.message);

    expect(
      validatePendingQueueMessageSizes(
        resolved.value,
        pendingDeliveryJobs,
        deliveryContext,
      ),
    ).toStrictEqual({
      ok: false,
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message:
          "eventhub: Queue message size 128001 bytes exceeds limit of 128000 bytes",
      },
    });
  });

  test("fails before persistence when a destination binding is missing", () => {
    // 1. Build a routed job plan with a missing binding.
    // 2. Confirm validation fails before delivery starts.
    const env = {
      OKAYAMA: new QueueMock(),
      HOKKAIDO: new QueueMock(),
    };
    const routing = createSubsetRouting(env);
    const pendingDeliveryJobs = createPendingDeliveryJobs(routing, [
      { kind: "nature", avoidUrban: false },
    ]);

    expect(
      resolveDestinationBindings(routing, pendingDeliveryJobs),
    ).toMatchObject({
      ok: false,
      error: {
        code: "DESTINATION_NOT_CONFIGURED",
        message: expect.stringContaining("OKINAWA not set"),
      },
    });
  });

  test("fails before persistence when a destination binding is unsupported", () => {
    const env = {
      ARCHIVE: {},
    };
    const routing = routeByConfig(env, {
      routes: [
        {
          condition: {
            path: "$.kind",
            exact: "archive",
          },
          // @ts-expect-error runtime validation
          destination: "ARCHIVE",
        },
      ],
    });
    const pendingDeliveryJobs = createPendingDeliveryJobs(routing, [
      { kind: "archive", avoidUrban: false },
    ]);

    expect(
      resolveDestinationBindings(routing, pendingDeliveryJobs),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_DESTINATION_BINDING",
        message: expect.stringContaining(
          "value of ARCHIVE is not a Queue, R2Bucket, or Workflow",
        ),
      },
    });
  });
});

describe("resolveDeliveryJobs", () => {
  test("resolves queues before sending", () => {
    const env = createEnv();
    const routing = createRouting(env);
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

    expect(resolveDeliveryJobs(routing, jobs)).toStrictEqual([
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
    const routing = createRouting(env);
    const payload = { kind: "archive", avoidUrban: false } as const;
    const jobs: PersistedDeliveryJob[] = [
      {
        id: "01TEST00000000000000000005",
        payloadId: "01TEST00000000000000000004",
        destination: "ARCHIVE",
        payload,
      },
    ];

    expect(resolveDeliveryJobs(routing, jobs)).toStrictEqual([
      {
        ...jobs[0],
        target: {
          kind: "r2",
          bucket: env.ARCHIVE,
        },
      },
    ]);
  });

  test("resolves Workflows before sending", () => {
    const workflow = new WorkflowMock();
    const env = {
      REPORT_WORKFLOW: workflow as unknown as Workflow<EventPayload>,
    };
    const routing = routeByConfig(env, { routes: [] });
    const jobs: PersistedDeliveryJob[] = [
      {
        id: "01TEST00000000000000000007",
        payloadId: "01TEST00000000000000000006",
        destination: "REPORT_WORKFLOW",
        payload: { kind: "report" },
      },
    ];

    expect(resolveDeliveryJobs(routing, jobs)).toStrictEqual([
      {
        ...jobs[0],
        target: {
          kind: "workflow",
          workflow,
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
    const routing = createRouting(env);
    const payload1 = { kind: "culture", avoidUrban: true };
    const payload2 = { kind: "nature", avoidUrban: false };
    const jobs = resolveDeliveryJobs(routing, [
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
      deliveryContext,
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
    const routing = createRouting(env);
    const jobs = resolveDeliveryJobs(
      routing,
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
      deliveryContext,
    );

    expect(env.OKAYAMA.sentBatches.map((batch) => batch.length)).toStrictEqual([
      100, 1,
    ]);
    expect(env.HOKKAIDO.sentBatches).toStrictEqual([]);
    expect(env.OKINAWA.sentBatches).toStrictEqual([]);
  });

  test("splits Queue batches by serialized UTF-8 JSON byte size", async () => {
    const env = createEnv();
    const routing = createRouting(env);
    const jobs = resolveDeliveryJobs(
      routing,
      Array.from({ length: 3 }, (_, i) => ({
        id: `01TEST0000000000000000000${i}`,
        payloadId: `01PAYL0000000000000000000${i}`,
        destination: "OKAYAMA",
        payload: { kind: "culture", data: "あ".repeat(42_000) },
      })),
    );

    await deliverJobs(
      jobs,
      { onDelivered: noopOnDelivered, onFailed: noopOnFailed },
      deliveryContext,
    );

    expect(env.OKAYAMA.sentBatches.map((batch) => batch.length)).toStrictEqual([
      2, 1,
    ]);
  });

  test("includes injected delivery metadata in Queue batch byte size", async () => {
    const env = createEnv();
    const routing = createRouting(env);
    const jobs = resolveDeliveryJobs(
      routing,
      Array.from({ length: 3 }, (_, i) => ({
        id: `01TEST0000000000000000000${i}`,
        payloadId: `01PAYL0000000000000000000${i}`,
        destination: "OKAYAMA",
        payload: createPayloadWithJsonBytes(85_300),
      })),
    );

    await deliverJobs(
      jobs,
      { onDelivered: noopOnDelivered, onFailed: noopOnFailed },
      {
        instanceId: "test-instance",
        instanceName: "test-name",
        includeDeliveryMetadata: true,
      },
    );

    expect(env.OKAYAMA.sentBatches.map((batch) => batch.length)).toStrictEqual([
      2, 1,
    ]);
  });

  test("reports an individually oversized Queue message without sending it", async () => {
    const env = createEnv();
    const routing = createRouting(env);
    const [job] = resolveDeliveryJobs(routing, [
      {
        id: "01TEST00000000000000000001",
        payloadId: "01PAYL00000000000000000000",
        destination: "OKAYAMA",
        payload: createPayloadWithJsonBytes(128_001),
      },
    ]);
    const onFailed = vi.fn();

    await deliverJobs(
      [job],
      { onDelivered: noopOnDelivered, onFailed },
      deliveryContext,
    );

    expect({
      sentBatches: env.OKAYAMA.sentBatches,
      failure: onFailed.mock.calls,
    }).toStrictEqual({
      sentBatches: [],
      failure: [
        [
          ["01TEST00000000000000000001"],
          expect.objectContaining({
            message:
              "eventhub: Queue message size 128001 bytes exceeds limit of 128000 bytes",
          }),
        ],
      ],
    });
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
    const routing = createSubsetRouting(env);

    expect(resolveDeliveryJobsResult(routing, jobs)).toStrictEqual({
      ok: false,
      error: {
        code: "DESTINATION_NOT_CONFIGURED",
        message: "eventhub: OKINAWA not set",
      },
    });
    expect(env.HOKKAIDO.sentBatches).toHaveLength(0);
    expect(env.OKAYAMA.sentBatches).toHaveLength(0);
  });

  test("creates one Workflow instance per delivery job in a batch", async () => {
    const workflow = new WorkflowMock();
    const routing = routeByConfig(
      { REPORT_WORKFLOW: workflow as unknown as Workflow<EventPayload> },
      { routes: [] },
    );
    const jobs = resolveDeliveryJobs(
      routing,
      Array.from({ length: 3 }, (_, index) => ({
        id: `workflow-job-${index}`,
        payloadId: `workflow-payload-${index}`,
        destination: "REPORT_WORKFLOW",
        payload: { kind: "report", index },
      })),
    );
    const onDelivered = vi.fn();

    await deliverJobs(
      jobs,
      { onDelivered, onFailed: noopOnFailed },
      deliveryContext,
    );

    expect(workflow.createBatchCalls).toStrictEqual([
      [
        { id: "workflow-job-0", params: { kind: "report", index: 0 } },
        { id: "workflow-job-1", params: { kind: "report", index: 1 } },
        { id: "workflow-job-2", params: { kind: "report", index: 2 } },
      ],
    ]);
    expect(onDelivered).toHaveBeenCalledWith([
      "workflow-job-0",
      "workflow-job-1",
      "workflow-job-2",
    ]);
  });

  test("splits Workflow delivery into batches of at most 100 instances", async () => {
    const workflow = new WorkflowMock();
    const routing = routeByConfig(
      { REPORT_WORKFLOW: workflow as unknown as Workflow<EventPayload> },
      { routes: [] },
    );
    const jobs = resolveDeliveryJobs(
      routing,
      Array.from({ length: 101 }, (_, index) => ({
        id: `workflow-job-${index}`,
        payloadId: `workflow-payload-${index}`,
        destination: "REPORT_WORKFLOW",
        payload: { index },
      })),
    );
    const delivered: string[][] = [];

    await deliverJobs(
      jobs,
      {
        onDelivered: (jobIds) => {
          delivered.push([...jobIds]);
        },
        onFailed: noopOnFailed,
      },
      deliveryContext,
    );

    expect({
      batchSizes: workflow.createBatchCalls.map((batch) => batch.length),
      deliveredSizes: delivered.map((jobIds) => jobIds.length),
    }).toStrictEqual({ batchSizes: [100, 1], deliveredSizes: [100, 1] });
  });

  test("treats existing Workflow instance IDs as successful handoffs", async () => {
    const existingId = "existing-workflow-job";
    const workflow = new WorkflowMock(
      [],
      [[existingId, { kind: "report", previous: true }]],
    );
    const routing = routeByConfig(
      { REPORT_WORKFLOW: workflow as unknown as Workflow<EventPayload> },
      { routes: [] },
    );
    const jobs = resolveDeliveryJobs(routing, [
      {
        id: existingId,
        payloadId: "payload-existing",
        destination: "REPORT_WORKFLOW",
        payload: { kind: "report", previous: false },
      },
      {
        id: "new-workflow-job",
        payloadId: "payload-new",
        destination: "REPORT_WORKFLOW",
        payload: { kind: "report", previous: false },
      },
    ]);
    const onDelivered = vi.fn();

    await deliverJobs(
      jobs,
      { onDelivered, onFailed: noopOnFailed },
      deliveryContext,
    );

    expect({
      instances: workflow.instances,
      delivered: onDelivered.mock.calls,
    }).toStrictEqual({
      instances: new Map([
        [existingId, { kind: "report", previous: true }],
        ["new-workflow-job", { kind: "report", previous: false }],
      ]),
      delivered: [[[existingId, "new-workflow-job"]]],
    });
  });

  test("injects delivery metadata into Workflow parameters", async () => {
    const workflow = new WorkflowMock();
    const routing = routeByConfig(
      { REPORT_WORKFLOW: workflow as unknown as Workflow<EventPayload> },
      { routes: [] },
    );
    const jobs = resolveDeliveryJobs(routing, [
      {
        id: "workflow-job-with-metadata",
        payloadId: "workflow-payload-with-metadata",
        destination: "REPORT_WORKFLOW",
        payload: { kind: "report" },
      },
    ]);

    await deliverJobs(
      jobs,
      { onDelivered: noopOnDelivered, onFailed: noopOnFailed },
      {
        instanceId: "eventhub-instance",
        instanceName: "named-hub",
        includeDeliveryMetadata: true,
      },
    );

    expect(workflow.createBatchCalls).toStrictEqual([
      [
        {
          id: "workflow-job-with-metadata",
          params: {
            kind: "report",
            __eventhub__: {
              instanceId: "eventhub-instance",
              instanceName: "named-hub",
              deliveryJobId: "workflow-job-with-metadata",
            },
          },
        },
      ],
    ]);
  });

  test("writes matched payloads to destination buckets", async () => {
    const env = createEnv();
    const routing = routeByConfig(env, {
      routes: [
        {
          condition: {
            path: "$.kind",
            exact: "archive",
          },
          destination: "ARCHIVE",
        },
      ],
    });
    const payload = { kind: "archive", avoidUrban: false };
    const jobs = resolveDeliveryJobs(routing, [
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
      deliveryContext,
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

  test("writes R2 payloads with a customized object key", async () => {
    const env = createEnv();
    const payload = { kind: "archive", tenant: "acme" };
    const objectKey = vi.fn(
      ({ payloadId, deliveryJobId, destination, instanceName }) =>
        `${instanceName}/${destination}/${payloadId}/${deliveryJobId}.json`,
    );
    const routing = routeByConfig(
      env,
      { routes: [] },
      { r2: { ARCHIVE: { objectKey } } },
    );
    const jobs = resolveDeliveryJobs(routing, [
      {
        id: "01TEST00000000000000000011",
        payloadId: "01TEST00000000000000000010",
        destination: "ARCHIVE",
        payload,
      },
    ]);

    await deliverJobs(
      jobs,
      { onDelivered: noopOnDelivered, onFailed: noopOnFailed },
      {
        instanceId: "test-instance-id",
        instanceName: "test-instance-name",
        includeDeliveryMetadata: false,
      },
    );

    expect(objectKey).toHaveBeenCalledWith({
      payload,
      payloadId: "01TEST00000000000000000010",
      deliveryJobId: "01TEST00000000000000000011",
      destination: "ARCHIVE",
      instanceId: "test-instance-id",
      instanceName: "test-instance-name",
    });
    expect((env.ARCHIVE as unknown as R2BucketMock).objects).toStrictEqual(
      new Map([
        [
          "test-instance-name/ARCHIVE/01TEST00000000000000000010/01TEST00000000000000000011.json",
          {
            body: JSON.stringify(payload),
            contentType: "application/json",
          },
        ],
      ]),
    );
  });

  test.each(["", 123])(
    "reports an invalid customized R2 object key (%j)",
    async (invalidKey) => {
      const env = createEnv();
      const routing = routeByConfig(
        env,
        { routes: [] },
        {
          r2: {
            ARCHIVE: {
              // @ts-expect-error exercise runtime validation
              objectKey: () => invalidKey,
            },
          },
        },
      );
      const jobs = resolveDeliveryJobs(routing, [
        {
          id: "01TEST00000000000000000011",
          payloadId: "01TEST00000000000000000010",
          destination: "ARCHIVE",
          payload: { kind: "archive" },
        },
      ]);
      const onFailed = vi.fn();

      await deliverJobs(
        jobs,
        { onDelivered: noopOnDelivered, onFailed },
        deliveryContext,
      );

      expect(onFailed).toHaveBeenCalledWith(
        ["01TEST00000000000000000011"],
        expect.objectContaining({
          message: "eventhub: R2 object key must be a non-empty string",
        }),
      );
    },
  );

  test("uses destination-specific keys when one payload fans out to R2 buckets", async () => {
    const first = new R2BucketMock();
    const second = new R2BucketMock();
    const env = {
      FIRST_ARCHIVE: first as unknown as R2Bucket,
      SECOND_ARCHIVE: second as unknown as R2Bucket,
    };
    const routing = routeByConfig(
      env,
      { routes: [] },
      {
        r2: {
          FIRST_ARCHIVE: {
            objectKey: ({ payloadId, deliveryJobId }) =>
              `primary/${payloadId}/${deliveryJobId}.json`,
          },
          SECOND_ARCHIVE: {
            objectKey: ({ payloadId, deliveryJobId }) =>
              `secondary/${payloadId}/${deliveryJobId}.json`,
          },
        },
      },
    );
    const payload = { kind: "archive" };
    const jobs = resolveDeliveryJobs(routing, [
      {
        id: "01TEST00000000000000000011",
        payloadId: "01TEST00000000000000000010",
        destination: "FIRST_ARCHIVE",
        payload,
      },
      {
        id: "01TEST00000000000000000012",
        payloadId: "01TEST00000000000000000010",
        destination: "SECOND_ARCHIVE",
        payload,
      },
    ]);

    await deliverJobs(
      jobs,
      { onDelivered: noopOnDelivered, onFailed: noopOnFailed },
      deliveryContext,
    );

    expect({
      first: [...first.objects.keys()],
      second: [...second.objects.keys()],
    }).toStrictEqual({
      first: [
        "primary/01TEST00000000000000000010/01TEST00000000000000000011.json",
      ],
      second: [
        "secondary/01TEST00000000000000000010/01TEST00000000000000000012.json",
      ],
    });
  });

  test("reports delivered job ids after each successful batch", async () => {
    // 1. Deliver enough jobs to produce two batches.
    // 2. Verify the success callback is invoked once per batch with the delivered job IDs.
    const env = createEnv();
    const routing = createRouting(env);
    const jobs = resolveDeliveryJobs(
      routing,
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
      deliveryContext,
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
    const routing = createSubsetRouting(env);
    const onDelivered = vi.fn();
    const onFailed = vi.fn();
    const jobs = resolveDeliveryJobs(routing, [
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

    await deliverJobs(jobs, { onDelivered, onFailed }, deliveryContext);

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
    const routing = routeByConfig(env, {
      routes: [
        ...baseRoutes,
        {
          condition: {
            path: "$.kind",
            exact: "archive",
          },
          destination: "ARCHIVE",
        },
      ],
    } as never);
    const onDelivered = vi.fn();
    const onFailed = vi.fn();
    const jobs = resolveDeliveryJobs(routing, [
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

    await deliverJobs(jobs, { onDelivered, onFailed }, deliveryContext);

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
  test("retries an ambiguous Workflow failure with the same instance IDs", async () => {
    // 1. Simulate instances being created before the first response is lost.
    // 2. Retry the persisted jobs and verify createBatch accepts the existing IDs.
    const workflow = new WorkflowMock([0]);
    const routing = routeByConfig(
      { REPORT_WORKFLOW: workflow as unknown as Workflow<EventPayload> },
      { routes: [] },
    );
    const jobs: PersistedDeliveryJob[] = [
      {
        id: "workflow-job-a",
        payloadId: "workflow-payload-a",
        destination: "REPORT_WORKFLOW",
        payload: { kind: "report", index: 0 },
      },
      {
        id: "workflow-job-b",
        payloadId: "workflow-payload-b",
        destination: "REPORT_WORKFLOW",
        payload: { kind: "report", index: 1 },
      },
    ];
    const onDelivered = vi.fn();
    const onFailed = vi.fn();

    await deliverPersistedJobs(
      routing,
      jobs,
      { onDelivered, onFailed },
      deliveryContext,
    );
    await deliverPersistedJobs(
      routing,
      jobs,
      { onDelivered, onFailed },
      deliveryContext,
    );

    expect({
      calls: workflow.createBatchCalls,
      instances: workflow.instances,
      failures: onFailed.mock.calls,
      deliveries: onDelivered.mock.calls,
    }).toStrictEqual({
      calls: [
        [
          { id: "workflow-job-a", params: { kind: "report", index: 0 } },
          { id: "workflow-job-b", params: { kind: "report", index: 1 } },
        ],
        [
          { id: "workflow-job-a", params: { kind: "report", index: 0 } },
          { id: "workflow-job-b", params: { kind: "report", index: 1 } },
        ],
      ],
      instances: new Map([
        ["workflow-job-a", { kind: "report", index: 0 }],
        ["workflow-job-b", { kind: "report", index: 1 }],
      ]),
      failures: [
        [
          ["workflow-job-a", "workflow-job-b"],
          expect.objectContaining({ message: "failed Workflow batch 0" }),
        ],
      ],
      deliveries: [[["workflow-job-a", "workflow-job-b"]]],
    });
  });

  test("reuses the same customized R2 key when retrying a delivery job", async () => {
    const archive = new R2BucketMock();
    const keys: string[] = [];
    const env = { ARCHIVE: archive as unknown as R2Bucket };
    const routing = routeByConfig(
      env,
      { routes: [] },
      {
        r2: {
          ARCHIVE: {
            objectKey: (context) => {
              const key = `retries/${context.payloadId}/${context.deliveryJobId}.json`;
              keys.push(key);
              return key;
            },
          },
        },
      },
    );
    const jobs: PersistedDeliveryJob[] = [
      {
        id: "01TEST00000000000000000011",
        payloadId: "01TEST00000000000000000010",
        destination: "ARCHIVE",
        payload: { kind: "archive" },
      },
    ];

    await deliverPersistedJobs(
      routing,
      jobs,
      { onDelivered: noopOnDelivered, onFailed: noopOnFailed },
      deliveryContext,
    );
    await deliverPersistedJobs(
      routing,
      jobs,
      { onDelivered: noopOnDelivered, onFailed: noopOnFailed },
      deliveryContext,
    );

    expect(keys).toStrictEqual([
      "retries/01TEST00000000000000000010/01TEST00000000000000000011.json",
      "retries/01TEST00000000000000000010/01TEST00000000000000000011.json",
    ]);
    expect([...archive.objects.keys()]).toStrictEqual([
      "retries/01TEST00000000000000000010/01TEST00000000000000000011.json",
    ]);
  });

  test("continues delivering other destinations when one destination binding is missing", async () => {
    // 1. Deliver persisted jobs with one unresolved destination.
    // 2. Verify the remaining destination still succeeds.
    const env = {
      HOKKAIDO: new QueueMock(),
    };
    const routing = createSubsetRouting(env);
    const onDelivered = vi.fn();
    const onFailed = vi.fn();

    await deliverPersistedJobs(
      routing,
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
      deliveryContext,
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
    const routing = routeByConfig(env, {
      routes: [
        {
          condition: {
            path: "$.kind",
            exact: "archive",
          },
          destination: "ARCHIVE",
        },
        {
          condition: {
            path: "$.kind",
            exact: "culture",
          },
          destination: "OKAYAMA",
        },
      ],
    } as never);
    const onDelivered = vi.fn();
    const onFailed = vi.fn();

    await deliverPersistedJobs(
      routing,
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
      deliveryContext,
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

  test("continues delivering other destinations when a Workflow batch fails", async () => {
    const workflow = new WorkflowMock([0]);
    const queue = new QueueMock();
    const env = {
      REPORT_WORKFLOW: workflow as unknown as Workflow<EventPayload>,
      EVENTS: queue,
    };
    const routing = routeByConfig(env, { routes: [] });
    const onDelivered = vi.fn();
    const onFailed = vi.fn();

    await deliverPersistedJobs(
      routing,
      [
        {
          id: "workflow-job-failing",
          payloadId: "workflow-payload-failing",
          destination: "REPORT_WORKFLOW",
          payload: { kind: "report" },
        },
        {
          id: "queue-job-healthy",
          payloadId: "queue-payload-healthy",
          destination: "EVENTS",
          payload: { kind: "event" },
        },
      ],
      { onDelivered, onFailed },
      deliveryContext,
    );

    expect({
      failures: onFailed.mock.calls,
      deliveries: onDelivered.mock.calls,
      queueBatches: queue.sentBatches,
    }).toStrictEqual({
      failures: [
        [
          ["workflow-job-failing"],
          expect.objectContaining({ message: "failed Workflow batch 0" }),
        ],
      ],
      deliveries: [[["queue-job-healthy"]]],
      queueBatches: [[{ body: { kind: "event" }, contentType: "json" }]],
    });
  });

  test("injects delivery metadata when includeDeliveryMetadata is true for Queue", async () => {
    // 1. Deliver jobs to a Queue with includeDeliveryMetadata enabled.
    // 2. Verify the sent payload includes the instance identity and job ID.
    const env = createEnv();
    const routing = createRouting(env);
    const payload = { kind: "culture", avoidUrban: true };
    const jobs = resolveDeliveryJobs(routing, [
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
      {
        instanceId: "test-instance",
        instanceName: "test-name",
        includeDeliveryMetadata: true,
      },
    );

    expect(env.OKAYAMA.sentBatches).toStrictEqual([
      [
        {
          body: {
            ...payload,
            __eventhub__: {
              instanceId: "test-instance",
              instanceName: "test-name",
              deliveryJobId: "01TEST00000000000000000001",
            },
          },
          contentType: "json",
        },
      ],
    ]);
  });

  test("injects delivery metadata when includeDeliveryMetadata is true for R2", async () => {
    // 1. Deliver jobs to an R2 bucket with includeDeliveryMetadata enabled.
    // 2. Verify the stored payload includes the instance identity and job ID.
    const env = createEnv();
    const routing = routeByConfig(env, {
      routes: [
        {
          condition: {
            path: "$.kind",
            exact: "archive",
          },
          destination: "ARCHIVE",
        },
      ],
    });
    const payload = { kind: "archive", avoidUrban: false };
    const jobs = resolveDeliveryJobs(routing, [
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
      {
        instanceId: "test-instance",
        instanceName: "test-name",
        includeDeliveryMetadata: true,
      },
    );

    const archive = env.ARCHIVE as unknown as R2BucketMock;
    const stored = archive.objects.get(
      "01TEST00000000000000000010/01TEST00000000000000000011.json",
    );
    expect(stored).toBeDefined();
    expect(JSON.parse(stored?.body ?? "{}")).toStrictEqual({
      ...payload,
      __eventhub__: {
        instanceId: "test-instance",
        instanceName: "test-name",
        deliveryJobId: "01TEST00000000000000000011",
      },
    });
  });

  test("merges delivery metadata with an existing __eventhub__ object", async () => {
    // 1. Deliver a payload that already has an __eventhub__ object.
    // 2. Verify authoritative metadata replaces reserved fields and preserves others.
    const env = createEnv();
    const routing = createRouting(env);
    const payload = {
      kind: "culture",
      __eventhub__: {
        customField: "value",
        instanceId: "untrusted",
        instanceName: "untrusted",
        deliveryJobId: "untrusted",
      },
    };
    const jobs = resolveDeliveryJobs(routing, [
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
      { instanceId: "test-instance", includeDeliveryMetadata: true },
    );

    expect(env.OKAYAMA.sentBatches).toStrictEqual([
      [
        {
          body: {
            kind: "culture",
            __eventhub__: {
              instanceId: "test-instance",
              customField: "value",
              deliveryJobId: "01TEST00000000000000000002",
            },
          },
          contentType: "json",
        },
      ],
    ]);
  });

  test("replaces non-object __eventhub__ with delivery metadata", async () => {
    // 1. Deliver a payload with __eventhub__ set to a non-object value.
    // 2. Verify it is replaced with the instance identity and job ID.
    const env = createEnv();
    const routing = createRouting(env);
    const payloadWithArray = {
      kind: "culture",
      __eventhub__: ["not", "an", "object"],
    };
    const jobs = resolveDeliveryJobs(routing, [
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
      {
        instanceId: "test-instance",
        instanceName: "test-name",
        includeDeliveryMetadata: true,
      },
    );

    expect(env.OKAYAMA.sentBatches).toStrictEqual([
      [
        {
          body: {
            kind: "culture",
            __eventhub__: {
              instanceId: "test-instance",
              instanceName: "test-name",
              deliveryJobId: "01TEST00000000000000000003",
            },
          },
          contentType: "json",
        },
      ],
    ]);
  });

  test("does not modify the original payload when injecting metadata", async () => {
    // 1. Deliver a payload with includeDeliveryMetadata enabled.
    // 2. Verify the original payload object is not mutated.
    const env = createEnv();
    const routing = createRouting(env);
    const payload = { kind: "culture", avoidUrban: true };
    const payloadCopy = { ...payload };
    const jobs = resolveDeliveryJobs(routing, [
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
      {
        instanceId: "test-instance",
        instanceName: "test-name",
        includeDeliveryMetadata: true,
      },
    );

    expect(payload).toStrictEqual(payloadCopy);
    expect(payload).not.toHaveProperty("__eventhub__");
  });
});
