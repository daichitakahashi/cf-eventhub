import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test, vi } from "vitest";

import { EVENT_HUB_STALE_AFTER_MS, type EventHubRegistry } from "./registry";
import type { TestEventHubWithFailingRegistry } from "./test";

const registry = (name = "default") => env.EVENT_HUB_REGISTRY.getByName(name);

const clearDefaultRegistry = async () => {
  await runInDurableObject(registry(), async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM eventhub_instances");
  });
};

describe("EventHubRegistry", () => {
  test("registers, refreshes, tombstones, and revives an instance", async () => {
    const stub = registry("lifecycle");
    const created = await stub.register("tenant:acme");

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE eventhub_instances SET last_seen_at = last_seen_at - 1000 WHERE name = ?",
        "tenant:acme",
      );
    });
    const refreshed = await stub.register("tenant:acme");
    expect(refreshed).toMatchObject({
      name: "tenant:acme",
      firstSeenAt: created.firstSeenAt,
      deletedAt: null,
      status: "active",
    });
    expect(Date.parse(refreshed.lastSeenAt)).toBeGreaterThan(
      Date.parse(created.lastSeenAt) - 1_000,
    );

    expect(await stub.delete("tenant:acme")).toBe(true);
    const deleted = await stub.list({ status: "deleted" });
    expect(deleted.instances).toMatchObject([
      { name: "tenant:acme", status: "deleted" },
    ]);
    const tombstone = deleted.instances[0]?.deletedAt;

    expect(await stub.delete("tenant:acme")).toBe(true);
    expect(
      (await stub.list({ status: "deleted" })).instances[0]?.deletedAt,
    ).toBe(tombstone);

    expect(await stub.register("tenant:acme")).toMatchObject({
      name: "tenant:acme",
      firstSeenAt: created.firstSeenAt,
      deletedAt: null,
      status: "active",
    });
  });

  test("classifies the stale cutoff with an exclusive stale boundary", async () => {
    const stub = registry("stale-cutoff");
    const now = Date.now();
    const cutoff = now - EVENT_HUB_STALE_AFTER_MS;
    await runInDurableObject(stub, async (_instance, state) => {
      for (const [name, lastSeenAt] of [
        ["before", cutoff - 10_000],
        ["boundary", cutoff + 1_000],
        ["after", cutoff + 10_000],
      ] as const) {
        state.storage.sql.exec(
          "INSERT INTO eventhub_instances (name, first_seen_at, last_seen_at, deleted_at) VALUES (?, ?, ?, NULL)",
          name,
          lastSeenAt,
          lastSeenAt,
        );
      }
    });

    expect({
      active: (await stub.list({ status: "active" })).instances.map(
        ({ name }) => name,
      ),
      stale: (await stub.list({ status: "stale" })).instances.map(
        ({ name }) => name,
      ),
    }).toStrictEqual({
      active: ["after", "boundary"],
      stale: ["before"],
    });
  });

  test("paginates each lifecycle by name without overlap", async () => {
    const stub = registry("pagination");
    for (const name of ["delta", "alpha", "charlie", "bravo"]) {
      await stub.register(name);
    }

    const first = await stub.list({ max: 2 });
    const second = await stub.list({ max: 2, cursor: first.cursor });
    expect({ first, second }).toMatchObject({
      first: {
        instances: [{ name: "alpha" }, { name: "bravo" }],
        cursor: expect.any(String),
      },
      second: {
        instances: [{ name: "charlie" }, { name: "delta" }],
      },
    });
    expect(second.cursor).toBeUndefined();
  });

  test("rejects invalid inputs and does not tombstone unknown names", async () => {
    const stub = registry("validation");
    await expect(stub.delete("unknown")).resolves.toBe(false);
    await runInDurableObject(stub, async (instance) => {
      const registryInstance = instance as EventHubRegistry;
      await expect(registryInstance.register("")).rejects.toThrow(
        "name must not be empty",
      );
      await expect(registryInstance.list({ max: 0 })).rejects.toThrow("1..100");
      await expect(
        registryInstance.list({ cursor: "not+a+cursor" }),
      ).rejects.toThrow("invalid cursor");
    });
    expect((await stub.list({ status: "deleted" })).instances).toStrictEqual(
      [],
    );
  });
});

describe("EventHub registry synchronization", () => {
  test("registers a named EventHub after activity and throttles refresh", async () => {
    // 1. Trigger an EventHub RPC and wait for its background Registry RPC.
    // 2. Trigger another activity and verify the persisted throttle timestamp is stable.
    await clearDefaultRegistry();
    const hub = env.REGISTERED_EVENT_HUB.getByName("tenant:registered");
    await hub.list();

    await vi.waitFor(async () => {
      expect(
        (await registry().list()).instances.some(
          (instance) =>
            instance.name === "tenant:registered" &&
            instance.status === "active",
        ),
      ).toBe(true);
    });
    let firstSyncedAt = 0;
    await runInDurableObject(hub, async (_instance, state) => {
      firstSyncedAt = state.storage.sql
        .exec<{ synced_at: number }>(
          "SELECT synced_at FROM registry_sync_state WHERE singleton = 1",
        )
        .one().synced_at;
    });

    await hub.list();
    await runInDurableObject(hub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ synced_at: number }>(
            "SELECT synced_at FROM registry_sync_state WHERE singleton = 1",
          )
          .one().synced_at,
      ).toBe(firstSyncedAt);
    });
  });

  test("revives a deleted entry on the next due synchronization", async () => {
    await clearDefaultRegistry();
    const hub = env.REGISTERED_EVENT_HUB.getByName("tenant:revived");
    await hub.list();
    await vi.waitFor(async () => {
      expect(
        (await registry().list()).instances.some(
          (instance) => instance.name === "tenant:revived",
        ),
      ).toBe(true);
    });
    await registry().delete("tenant:revived");
    await runInDurableObject(hub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM registry_sync_state");
    });

    await hub.list();
    await vi.waitFor(async () => {
      expect(
        (await registry().list()).instances.some(
          (instance) =>
            instance.name === "tenant:revived" && instance.status === "active",
        ),
      ).toBe(true);
    });
  });

  test("does not register an unnamed EventHub", async () => {
    await clearDefaultRegistry();
    const hub = env.REGISTERED_EVENT_HUB.get(
      env.REGISTERED_EVENT_HUB.newUniqueId(),
    );
    await hub.list();
    expect((await registry().list()).instances).toStrictEqual([]);
  });

  test("isolates Registry failures and retries on the next activity", async () => {
    // 1. Run an EventHub RPC against a Registry stub that always rejects.
    // 2. Verify the RPC succeeds, no success timestamp is stored, and the next RPC retries.
    const hub = env.EVENT_HUB_WITH_FAILING_REGISTRY.getByName("isolated");

    await expect(hub.list()).resolves.toStrictEqual({ payloads: [] });
    await vi.waitFor(async () => {
      await runInDurableObject(hub, async (instance, state) => {
        expect({
          attempts: (instance as TestEventHubWithFailingRegistry)
            .registryAttempts,
          syncRows: state.storage.sql
            .exec("SELECT synced_at FROM registry_sync_state")
            .toArray(),
        }).toStrictEqual({ attempts: 1, syncRows: [] });
      });
    });

    await expect(hub.list()).resolves.toStrictEqual({ payloads: [] });
    await vi.waitFor(async () => {
      await runInDurableObject(hub, async (instance) => {
        expect(
          (instance as TestEventHubWithFailingRegistry).registryAttempts,
        ).toBe(2);
      });
    });
  });
});
