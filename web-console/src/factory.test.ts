import type { EventHubInstance, EventHubRegistry } from "cf-eventhub";
import { describe, expect, test, vi } from "vitest";

import { listAllInstances } from "./factory";

describe("listAllInstances", () => {
  test("returns the first 10,000 instances when more pages remain", async () => {
    const list = vi.fn(async ({ cursor }: { cursor?: string }) => {
      const page = cursor === undefined ? 0 : Number(cursor);
      return {
        ok: true as const,
        value: {
          instances: Array.from({ length: 100 }, (_, index) => ({
            name: `instance-${page * 100 + index}`,
          })) as EventHubInstance[],
          cursor: String(page + 1),
        },
      };
    });
    const registry = { list } as unknown as DurableObjectStub<EventHubRegistry>;

    const result = await listAllInstances(registry, "active");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(10_000);
    expect(result.value[0]?.name).toBe("instance-0");
    expect(result.value.at(-1)?.name).toBe("instance-9999");
    expect(list).toHaveBeenCalledTimes(100);
  });
});
