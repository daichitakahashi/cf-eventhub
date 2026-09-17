import { describe, expect, test } from "vitest";

import { eventHubError, serializeError } from "./errors";

describe("eventHubError", () => {
  test("exposes stable fields as serializable own properties", () => {
    const error = eventHubError("INVALID_ARGUMENT", "invalid input");

    expect(JSON.parse(JSON.stringify(error))).toStrictEqual({
      name: "EventHubError",
      message: "invalid input",
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("serializeError", () => {
  test("preserves diagnostics while making circular causes serializable", () => {
    const cause: Record<string, unknown> = { requestId: "request-1" };
    cause.self = cause;
    const error = new Error("delivery failed", { cause });

    const serialized = serializeError(error);

    expect(serialized).toMatchObject({
      name: "Error",
      message: "delivery failed",
      stack: expect.any(String),
      cause: { requestId: "request-1", self: "[Circular]" },
    });
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });
});
