import { assert, describe, expect, test, vi } from "vitest";

import {
  FastPathClient,
  type FastPathPayload,
  parseFastPathRequest,
} from "./fast-path";
import { DefaultLogger } from "./logger";

describe("fast path signing", () => {
  test("FastPathClient sends verifiable HMAC request", async () => {
    const secret = "test-secret";
    const payloads: FastPathPayload[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const payload = await parseFastPathRequest(request, secret);
        assert(payload);
        payloads.push(payload);
        return Response.json({ ok: true });
      },
    );

    try {
      const client = new FastPathClient(
        "https://executor.example/__cf_eventhub/fast-path",
        secret,
        new DefaultLogger("ERROR"),
      );
      await client.dispatch([
        {
          dispatchId: "dispatch-id",
          retryDelay: { type: "constant", interval: 5 },
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(payloads).toEqual([
      {
        dispatches: [
          {
            dispatchId: "dispatch-id",
            retryDelay: { type: "constant", interval: 5 },
          },
        ],
      },
    ]);
  });

  test("parseFastPathRequest rejects invalid signature", async () => {
    const request = new Request(
      "https://executor.example/__cf_eventhub/fast-path",
      {
        method: "POST",
        headers: {
          "x-cf-eventhub-timestamp": Math.floor(Date.now() / 1000).toString(),
          "x-cf-eventhub-signature": "v1=deadbeef",
        },
        body: JSON.stringify({ dispatches: [] }),
      },
    );

    await expect(parseFastPathRequest(request, "test-secret")).resolves.toBe(
      null,
    );
  });
});
