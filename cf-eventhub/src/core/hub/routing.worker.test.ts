import * as v from "valibot";
import { describe, expect, test } from "vitest";

import { Config, type ConfigInput, findRoutes } from "./routing";

describe("findRoutes", () => {
  describe("exact comparator", () => {
    const config = v.parse(Config, {
      routes: [
        {
          condition: {
            path: "$.eventName",
            exact: "orderPlaced",
          },
          destination: "ORDER_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
        {
          condition: {
            path: "$.eventName",
            exact: "paymentCompleted",
          },
          destination: "PAYMENT_HANDLER",
          delaySeconds: 1,
          maxRetries: 10,
        },
      ],
    } satisfies ConfigInput);

    test("order event captured by ORDER_HANDLER", () => {
      const routes = findRoutes(config, { eventName: "orderPlaced" });
      expect(routes).toStrictEqual([
        {
          destination: "ORDER_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
      ]);
    });

    test("payment event captured by PAYMENT_HANDLER", () => {
      const routes = findRoutes(config, { eventName: "paymentCompleted" });
      expect(routes).toStrictEqual([
        {
          destination: "PAYMENT_HANDLER",
          delaySeconds: 1,
          maxRetries: 10,
        },
      ]);
    });
  });

  describe("match comparator", () => {
    const config = v.parse(Config, {
      routes: [
        {
          condition: {
            path: "$.eventName",
            match: "^order.*",
          },
          destination: "ORDER_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
        {
          condition: {
            path: "$.eventName",
            match: "^payment.*",
          },
          destination: "PAYMENT_HANDLER",
          delaySeconds: 1,
          maxRetries: 10,
        },
      ],
    } satisfies ConfigInput);

    test("order event captured by ORDER_HANDLER", () => {
      const routes = findRoutes(config, { eventName: "orderPlaced" });
      expect(routes).toStrictEqual([
        {
          destination: "ORDER_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
      ]);
    });

    test("payment event captured by PAYMENT_HANDLER", () => {
      const routes = findRoutes(config, { eventName: "paymentCompleted" });
      expect(routes).toStrictEqual([
        {
          destination: "PAYMENT_HANDLER",
          delaySeconds: 1,
          maxRetries: 10,
        },
      ]);
    });
  });

  describe("exists comparator", () => {
    const config = v.parse(Config, {
      routes: [
        {
          condition: {
            path: "$.orderId",
            exists: true,
          },
          destination: "ORDER_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
        {
          condition: {
            path: "$.userId",
            exists: true,
          },
          destination: "USER_HANDLER",
          delaySeconds: 1,
          maxRetries: 10,
        },
      ],
    } satisfies ConfigInput);

    test("order event captured by ORDER_HANDLER", () => {
      const routes = findRoutes(config, { orderId: null });
      expect(routes).toStrictEqual([
        {
          destination: "ORDER_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
      ]);
    });

    test("user event captured by USER_HANDLER", () => {
      const routes = findRoutes(config, { userId: null });
      expect(routes).toStrictEqual([
        {
          destination: "USER_HANDLER",
          delaySeconds: 1,
          maxRetries: 10,
        },
      ]);
    });
  });

  describe("'allOf' operator", () => {
    const config = v.parse(Config, {
      routes: [
        {
          condition: {
            allOf: [
              {
                path: "$.userId",
                exists: true,
              },
              {
                path: "$.name",
                match: "^John .*",
              },
            ],
          },
          destination: "USER_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
      ],
    } satisfies ConfigInput);

    test("payload with userId and name 'John Doe' captured by user handler", () => {
      const routes = findRoutes(config, {
        userId: "123",
        name: "John Doe",
      });
      expect(routes).toStrictEqual([
        {
          destination: "USER_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
      ]);
    });

    test("payload without userId doesn't captured by user handler", () => {
      const routes = findRoutes(config, {
        name: "John Doe",
      });
      expect(routes).toStrictEqual([]);
    });

    test("payload with name 'Jane Doe' doesn't captured by user handler", () => {
      const routes = findRoutes(config, {
        userId: "123",
        name: "Jane Doe",
      });
      expect(routes).toStrictEqual([]);
    });
  });

  describe("'anyOf' operator", () => {
    const config = v.parse(Config, {
      routes: [
        {
          condition: {
            anyOf: [
              {
                path: "$.eventName",
                match: "^order.*",
              },
              {
                path: "$.eventName",
                match: "^shipment.*",
              },
            ],
          },
          destination: "ORDER_SHIPMENT_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
      ],
    } satisfies ConfigInput);

    test("payload with eventName 'orderPlaced' captured by order shipment handler", () => {
      const routes = findRoutes(config, {
        eventName: "orderPlaced",
      });
      expect(routes).toStrictEqual([
        {
          destination: "ORDER_SHIPMENT_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
      ]);
    });

    test("payload with eventName 'shipmentCreated' captured by order shipment handler", () => {
      const routes = findRoutes(config, {
        eventName: "shipmentCreated",
      });
      expect(routes).toStrictEqual([
        {
          destination: "ORDER_SHIPMENT_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
      ]);
    });

    test("payload with eventName 'paymentCompleted' doesn't captured by order shipment handler", () => {
      const routes = findRoutes(config, {
        eventName: "paymentCompleted",
      });
      expect(routes).toStrictEqual([]);
    });
  });

  describe("'not' operator", () => {
    const config = v.parse(Config, {
      routes: [
        {
          condition: {
            not: {
              path: "$.error",
              exists: true,
            },
          },
          destination: "NEXT_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
      ],
    } satisfies ConfigInput);

    test("payload without error captured by next handler", () => {
      const routes = findRoutes(config, {
        message: "Hello, world!",
      });
      expect(routes).toStrictEqual([
        {
          destination: "NEXT_HANDLER",
          delaySeconds: 10,
          maxRetries: 3,
        },
      ]);
    });

    test("payload with error doesn't captured by next handler", () => {
      const routes = findRoutes(config, {
        error: "Something went wrong",
      });
      expect(routes).toStrictEqual([]);
    });
  });
});
