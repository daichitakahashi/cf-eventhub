import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, expect, expectTypeOf, test } from "vitest";
import { getEventHubFromPayload } from "./index";
import type { TestEventHub, TestEventHubWithJobId } from "./test";

test.each([
  undefined,
  null,
  "payload",
  1,
  [],
  {},
  { __eventhub__: null },
  { __eventhub__: [] },
  { __eventhub__: "metadata" },
  { __eventhub__: {} },
  { __eventhub__: { instanceId: 1 } },
  { __eventhub__: { instanceId: "" } },
  { __eventhub__: { instanceId: "invalid" } },
  { __eventhub__: { instanceId: "invalid", instanceName: "name" } },
])("returns undefined for invalid payload %j", (payload) => {
  expect(getEventHubFromPayload(env.EVENT_HUB, payload)).toBeUndefined();
});

test("returns undefined for an ID from another namespace", () => {
  const instanceId = env.EVENT_HUB_WITH_JOB_ID.idFromName("foreign").toString();
  expect(
    getEventHubFromPayload(env.EVENT_HUB, {
      __eventhub__: { instanceId },
    }),
  ).toBeUndefined();
});

test("resolves an unnamed instance without requiring a delivery job ID", () => {
  const id = env.EVENT_HUB_WITH_JOB_ID.newUniqueId();
  const hub = getEventHubFromPayload(env.EVENT_HUB_WITH_JOB_ID, {
    __eventhub__: { instanceId: id.toString() },
  });
  expectTypeOf(hub).toEqualTypeOf<
    DurableObjectStub<TestEventHubWithJobId> | undefined
  >();
  expect(hub?.id.toString()).toBe(id.toString());
});

test("resolves a valid named instance by name", () => {
  const name = "payload-named";
  const id = env.EVENT_HUB_WITH_JOB_ID.idFromName(name);
  const hub = getEventHubFromPayload(env.EVENT_HUB_WITH_JOB_ID, {
    __eventhub__: { instanceId: id.toString(), instanceName: name },
  });

  expect(hub?.id.toString()).toBe(id.toString());
  expect(hub?.id.name).toBe(name);
});

test.each(["", 123, "another-name"])(
  "returns undefined for an invalid or mismatched instance name: %j",
  (instanceName) => {
    const id = env.EVENT_HUB_WITH_JOB_ID.idFromName("payload-named");
    expect(
      getEventHubFromPayload(env.EVENT_HUB_WITH_JOB_ID, {
        __eventhub__: { instanceId: id.toString(), instanceName },
      }),
    ).toBeUndefined();
  },
);

test("reports shared-queue failures to their originating instances", async () => {
  // 1. Publish from two instances into the same destination.
  // 2. Resolve each delivered payload and report its failure through RPC.
  // 3. Verify each instance records only its own job.
  const namespace = env.EVENT_HUB_WITH_JOB_ID;
  for (const name of ["payload-tenant-acme", "payload-orders"]) {
    const source = namespace.getByName(name);
    await source.publish({ type: "queue" });
    const payload = await runInDurableObject(
      source,
      async (instance) =>
        (instance as TestEventHubWithJobId).queue.sentBatches[0]?.[0]?.body,
    );
    const hub = getEventHubFromPayload(namespace, payload);
    assert(hub);
    expect(hub.id.toString()).toBe(source.id.toString());
    expect(await hub.reportFailure(payload)).toBe(true);
    expect(await hub.reportFailure(payload)).toBe(false);
    await runInDurableObject(source, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT delivery_job_id FROM delivery_job_failures")
          .toArray(),
      ).toStrictEqual([
        {
          delivery_job_id: (payload?.__eventhub__ as { deliveryJobId: string })
            .deliveryJobId,
        },
      ]);
    });
  }
});

test.each([undefined, "", 123, "another-instance"])(
  "rejects failure reports with a missing or mismatched instance ID: %j",
  async (instanceId) => {
    const hub = env.EVENT_HUB.getByName("payload-wrong-instance");
    await runInDurableObject(hub, async (instance) => {
      await expect(
        (instance as TestEventHub).reportFailure({
          __eventhub__: { instanceId, deliveryJobId: "job" },
        }),
      ).rejects.toThrow("eventhub: instanceId does not match this instance");
    });
  },
);
