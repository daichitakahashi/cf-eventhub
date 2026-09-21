import { describe, expect, test, vi } from "vitest";

import { resultError, resultOk, rpcBoundary, serializeError } from "./errors";

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

describe("rpcBoundary", () => {
  test.each([
    "INVALID_ARGUMENT",
    "INVALID_CURSOR",
    "PAYLOAD_TOO_LARGE",
    "DESTINATION_NOT_CONFIGURED",
    "INVALID_DESTINATION_BINDING",
    "INSTANCE_MISMATCH",
  ] as const)("creates the %s application error result", (code) => {
    expect(resultError(code, `message for ${code}`)).toStrictEqual({
      ok: false,
      error: { code, message: `message for ${code}` },
    });
  });

  test("returns distinct success shapes for void and value results", async () => {
    expect({
      voidResult: await rpcBoundary<void>("void", () => resultOk()),
      valueResult: await rpcBoundary<number>("value", () => resultOk(42)),
    }).toStrictEqual({
      voidResult: { ok: true },
      valueResult: { ok: true, value: 42 },
    });
  });

  test("preserves an explicit undefined value", () => {
    expect(resultOk<string | undefined>(undefined)).toStrictEqual({
      ok: true,
      value: undefined,
    });
  });

  test("logs unexpected exceptions without exposing their details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = new Error("database password is secret");

    expect(
      await rpcBoundary("test.internal", () => {
        throw thrown;
      }),
    ).toStrictEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "eventhub: internal error" },
    });
    expect(log).toHaveBeenCalledWith(
      "eventhub: RPC request failed",
      expect.objectContaining({
        operation: "test.internal",
        error: expect.objectContaining({
          message: "database password is secret",
          stack: expect.any(String),
        }),
      }),
    );
    log.mockRestore();
  });

  test("does not infer application failures from thrown errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await rpcBoundary("test.thrown-application-error", () => {
        throw new Error("must be returned explicitly");
      }),
    ).toStrictEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "eventhub: internal error" },
    });
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
