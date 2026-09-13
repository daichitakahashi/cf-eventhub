import { describe, expect, test, vi } from "vitest";

import * as jsonpath from "./jsonpath-lite";
import { type Config, findRoutes, routeByConfig } from "./routing";

describe("findRoutes", () => {
  test("returns destination for exact comparator", () => {
    const config: Config<{ ORDER_HANDLER: Queue }> = {
      routes: [
        {
          condition: {
            path: "$.eventName",
            exact: "orderPlaced",
          },
          destination: "ORDER_HANDLER",
        },
      ],
    };

    expect(findRoutes(config, { eventName: "orderPlaced" })).toStrictEqual([
      { destination: "ORDER_HANDLER" },
    ]);
  });

  test("returns destination for match comparator", () => {
    const config: Config<{ ORDER_HANDLER: Queue }> = {
      routes: [
        {
          condition: {
            path: "$.eventName",
            match: /^order.*/,
          },
          destination: "ORDER_HANDLER",
        },
      ],
    };

    expect(findRoutes(config, { eventName: "orderPlaced" })).toStrictEqual([
      { destination: "ORDER_HANDLER" },
    ]);
  });

  test("returns destination for exists comparator", () => {
    const config: Config<{ ORDER_HANDLER: Queue }> = {
      routes: [
        {
          condition: {
            path: "$.orderId",
            exists: true,
          },
          destination: "ORDER_HANDLER",
        },
      ],
    };

    expect(findRoutes(config, { orderId: null })).toStrictEqual([
      { destination: "ORDER_HANDLER" },
    ]);
  });

  test("treats undefined properties as absent for exists comparator", () => {
    const config: Config<{ ORDER_HANDLER: Queue }> = {
      routes: [
        {
          condition: {
            path: "$.orderId",
            exists: true,
          },
          destination: "ORDER_HANDLER",
        },
      ],
    };

    expect(findRoutes(config, { orderId: undefined })).toStrictEqual([]);
  });

  test("does not match inherited properties for exists comparator", () => {
    const config: Config<{ ORDER_HANDLER: Queue }> = {
      routes: [
        {
          condition: {
            path: "$.toString",
            exists: true,
          },
          destination: "ORDER_HANDLER",
        },
      ],
    };

    expect(findRoutes(config, {})).toStrictEqual([]);
  });

  test("evaluates numeric comparators", () => {
    const config: Config<{
      LTE: Queue;
      GTE: Queue;
      LT: Queue;
      GT: Queue;
    }> = {
      routes: [
        {
          condition: {
            path: "$.value",
            lte: 100,
          },
          destination: "LTE",
        },
        {
          condition: {
            path: "$.value",
            gte: 100,
          },
          destination: "GTE",
        },
        {
          condition: {
            path: "$.value",
            lt: 100,
          },
          destination: "LT",
        },
        {
          condition: {
            path: "$.value",
            gt: 100,
          },
          destination: "GT",
        },
      ],
    };

    expect(findRoutes(config, { value: 99 })).toStrictEqual([
      { destination: "LTE" },
      { destination: "LT" },
    ]);
    expect(findRoutes(config, { value: 100 })).toStrictEqual([
      { destination: "LTE" },
      { destination: "GTE" },
    ]);
    expect(findRoutes(config, { value: 101 })).toStrictEqual([
      { destination: "GTE" },
      { destination: "GT" },
    ]);
  });

  test("evaluates zero-valued numeric comparators", () => {
    const config: Config<{
      LTE_ZERO: Queue;
      GTE_ZERO: Queue;
      LT_ZERO: Queue;
      GT_ZERO: Queue;
    }> = {
      routes: [
        {
          condition: {
            path: "$.value",
            lte: 0,
          },
          destination: "LTE_ZERO",
        },
        {
          condition: {
            path: "$.value",
            gte: 0,
          },
          destination: "GTE_ZERO",
        },
        {
          condition: {
            path: "$.value",
            lt: 0,
          },
          destination: "LT_ZERO",
        },
        {
          condition: {
            path: "$.value",
            gt: 0,
          },
          destination: "GT_ZERO",
        },
      ],
    };

    expect(findRoutes(config, { value: -1 })).toStrictEqual([
      { destination: "LTE_ZERO" },
      { destination: "LT_ZERO" },
    ]);
    expect(findRoutes(config, { value: 0 })).toStrictEqual([
      { destination: "LTE_ZERO" },
      { destination: "GTE_ZERO" },
    ]);
    expect(findRoutes(config, { value: 1 })).toStrictEqual([
      { destination: "GTE_ZERO" },
      { destination: "GT_ZERO" },
    ]);
  });

  test("evaluates logical operators", () => {
    const config: Config<{
      TOKYO: Queue;
      JAPAN: Queue;
      ACTIVE_ONLY: Queue;
    }> = {
      routes: [
        {
          condition: {
            allOf: [
              { path: "$.kind", exact: "culture" },
              { path: "$.avoidUrban", exact: false },
            ],
          },
          destination: "TOKYO",
        },
        {
          condition: {
            anyOf: [
              { path: "$.kind", exact: "culture" },
              { path: "$.kind", exact: "nature" },
            ],
          },
          destination: "JAPAN",
        },
        {
          condition: {
            not: { path: "$.disabled", exact: true },
          },
          destination: "ACTIVE_ONLY",
        },
      ],
    };

    expect(
      findRoutes(config, {
        kind: "culture",
        avoidUrban: false,
        disabled: false,
      }),
    ).toStrictEqual([
      { destination: "TOKYO" },
      { destination: "JAPAN" },
      { destination: "ACTIVE_ONLY" },
    ]);
  });

  test("reuses parsed json paths when a cache is provided", () => {
    const config: Config<{ ORDER_HANDLER: Queue }> = {
      routes: [
        {
          condition: {
            path: "$.eventName",
            exact: "orderPlaced",
          },
          destination: "ORDER_HANDLER",
        },
      ],
    };
    const pathCache = new Map();

    expect(
      findRoutes(config, { eventName: "orderPlaced" }, pathCache),
    ).toStrictEqual([{ destination: "ORDER_HANDLER" }]);
    expect(pathCache.size).toBe(1);
    const cached = new Map(pathCache);
    expect(
      findRoutes(config, { eventName: "orderPlaced" }, pathCache),
    ).toStrictEqual([{ destination: "ORDER_HANDLER" }]);
    expect(pathCache).toStrictEqual(cached);
  });
});

describe("routeByConfig", () => {
  test("precompiles each unique path once when the strategy is created", () => {
    const parsePath = vi.spyOn(jsonpath, "parsePath");
    const env = {
      ORDER_HANDLER: {} as Queue,
    };
    const strategy = routeByConfig(env, {
      routes: [
        {
          condition: {
            path: "$.eventName",
            exact: "orderPlaced",
          },
          destination: "ORDER_HANDLER",
        },
        {
          condition: {
            not: {
              path: "$.eventName",
              exact: "orderCancelled",
            },
          },
          destination: "ORDER_HANDLER",
        },
      ],
    });

    expect(parsePath).toHaveBeenCalledTimes(1);
    strategy.findRoutes({ eventName: "orderPlaced" });
    strategy.findRoutes({ eventName: "orderPlaced" });
    expect(parsePath).toHaveBeenCalledTimes(1);
    parsePath.mockRestore();
  });

  test.each([
    ["comparator", { path: "$.items[", exists: true }],
    [
      "allOf",
      {
        allOf: [
          { path: "$.valid", exists: true },
          { path: "$.", exists: true },
        ],
      },
    ],
    ["anyOf", { anyOf: [{ path: "$.items[nope]", exists: true }] }],
    ["not", { not: { path: "$.valid..invalid", exists: true } }],
  ])("throws for an invalid path nested in %s", (_name, condition) => {
    const env = { ORDER_HANDLER: {} as Queue };

    expect(() =>
      routeByConfig(env, {
        routes: [
          {
            condition: condition as Config<
              typeof env
            >["routes"][number]["condition"],
            destination: "ORDER_HANDLER",
          },
        ],
      }),
    ).toThrow();
  });

  test("throws a configuration error for a malformed condition", () => {
    const env = { ORDER_HANDLER: {} as Queue };

    expect(() =>
      routeByConfig(env, {
        routes: [
          {
            condition: {} as Config<typeof env>["routes"][number]["condition"],
            destination: "ORDER_HANDLER",
          },
        ],
      }),
    ).toThrow(
      "eventhub: routing condition must contain path, allOf, anyOf, or not",
    );
  });

  test("treats a valid path missing from an event as a non-match", () => {
    const env = { ORDER_HANDLER: {} as Queue };
    const strategy = routeByConfig(env, {
      routes: [
        {
          condition: { path: "$.order.id", exists: true },
          destination: "ORDER_HANDLER",
        },
      ],
    });

    expect(strategy.findRoutes({ eventName: "orderPlaced" })).toStrictEqual([]);
  });

  test("resolves queue and R2 destinations from env", () => {
    const queue = { sendBatch: async () => {} } as unknown as Queue;
    const bucket = {
      put: async () => ({}),
      createMultipartUpload: async () => ({}),
    } as unknown as R2Bucket;
    const strategy = routeByConfig(
      {
        QUEUE_DESTINATION: queue,
        ARCHIVE: bucket,
      },
      {
        routes: [],
      },
    );

    expect(strategy.resolveDestination("QUEUE_DESTINATION")).toStrictEqual({
      kind: "queue",
      queue,
    });
    expect(strategy.resolveDestination("ARCHIVE")).toStrictEqual({
      kind: "r2",
      bucket,
    });
  });

  test("attaches a configured object key factory to R2 destinations", () => {
    const bucket = {
      put: async () => ({}),
      createMultipartUpload: async () => ({}),
    } as unknown as R2Bucket;
    const r2ObjectKey = () => "custom/key.json";
    const strategy = routeByConfig(
      { ARCHIVE: bucket },
      { routes: [] },
      { r2: { ARCHIVE: { objectKey: r2ObjectKey } } },
    );

    expect(strategy.resolveDestination("ARCHIVE")).toStrictEqual({
      kind: "r2",
      bucket,
      objectKey: r2ObjectKey,
    });
  });
});
