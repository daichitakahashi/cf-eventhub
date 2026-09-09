import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import {
  listInstances,
  registerInstance,
  tombstoneInstance,
} from "./registry-store";

describe("registry store", () => {
  test("preserves firstSeenAt and revives the same byte-sensitive name", async () => {
    const stub = env.EVENT_HUB_REGISTRY.getByName("store-upsert");
    await runInDurableObject(stub, async (_instance, state) => {
      const first = registerInstance(
        state.storage.sql,
        "Tenant:Acme",
        1_000,
        0,
      );
      const refreshed = registerInstance(
        state.storage.sql,
        "Tenant:Acme",
        2_000,
        0,
      );
      expect({ first, refreshed }).toMatchObject({
        first: {
          name: "Tenant:Acme",
          firstSeenAt: "1970-01-01T00:00:01.000Z",
          lastSeenAt: "1970-01-01T00:00:01.000Z",
          deletedAt: null,
        },
        refreshed: {
          name: "Tenant:Acme",
          firstSeenAt: "1970-01-01T00:00:01.000Z",
          lastSeenAt: "1970-01-01T00:00:02.000Z",
          deletedAt: null,
        },
      });

      expect(tombstoneInstance(state.storage.sql, "Tenant:Acme", 3_000)).toBe(
        true,
      );
      expect(tombstoneInstance(state.storage.sql, "Tenant:Acme", 4_000)).toBe(
        true,
      );
      expect(tombstoneInstance(state.storage.sql, "tenant:acme", 4_000)).toBe(
        false,
      );
      const revived = registerInstance(
        state.storage.sql,
        "Tenant:Acme",
        5_000,
        0,
      );
      expect(revived).toMatchObject({
        firstSeenAt: "1970-01-01T00:00:01.000Z",
        lastSeenAt: "1970-01-01T00:00:05.000Z",
        deletedAt: null,
        status: "active",
      });
    });
  });

  test("uses one exclusive cutoff and stable name pagination for all statuses", async () => {
    const stub = env.EVENT_HUB_REGISTRY.getByName("store-list");
    await runInDurableObject(stub, async (_instance, state) => {
      const cutoff = 10_000;
      for (const [name, lastSeenAt, deletedAt] of [
        ["active-after", cutoff + 1, null],
        ["active-boundary", cutoff, null],
        ["deleted", cutoff + 1, 20_000],
        ["stale-a", cutoff - 1, null],
        ["stale-b", cutoff - 2, null],
      ] as const) {
        state.storage.sql.exec(
          "INSERT INTO eventhub_instances (name, first_seen_at, last_seen_at, deleted_at) VALUES (?, ?, ?, ?)",
          name,
          lastSeenAt,
          lastSeenAt,
          deletedAt,
        );
      }

      const firstStalePage = listInstances(
        state.storage.sql,
        "stale",
        undefined,
        1,
        cutoff,
      );
      const secondStalePage = listInstances(
        state.storage.sql,
        "stale",
        firstStalePage.nextName,
        1,
        cutoff,
      );
      expect({
        active: listInstances(
          state.storage.sql,
          "active",
          undefined,
          100,
          cutoff,
        ).instances.map(({ name }) => name),
        deleted: listInstances(
          state.storage.sql,
          "deleted",
          undefined,
          100,
          cutoff,
        ).instances.map(({ name }) => name),
        firstStalePage: firstStalePage.instances.map(({ name }) => name),
        secondStalePage: secondStalePage.instances.map(({ name }) => name),
      }).toStrictEqual({
        active: ["active-after", "active-boundary"],
        deleted: ["deleted"],
        firstStalePage: ["stale-a"],
        secondStalePage: ["stale-b"],
      });
      expect(secondStalePage.nextName).toBeUndefined();
    });
  });
});
