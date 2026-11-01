import assert from "node:assert/strict";
import test from "node:test";
import { percentile, run, seed, seedHubName, summarize } from "./load.mjs";

test("percentile uses the nearest-rank definition", () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 99), 4);
  assert.equal(percentile([], 50), null);
});

test("summarize reports sustained throughput and latency percentiles", () => {
  assert.deepEqual(
    summarize({
      latencies: [4, 1, 3, 2],
      successes: 4,
      failures: 1,
      elapsedMs: 2_000,
    }),
    {
      requests: 5,
      successes: 4,
      failures: 1,
      throughputPerSecond: 2,
      latencyMs: { min: 1, p50: 2, p90: 4, p95: 4, p99: 4, max: 4 },
    },
  );
});

test("seed batches rotate across partitions", () => {
  assert.deepEqual(
    [0, 100, 200, 300].map((start) => seedHubName("retained", 3, start)),
    ["retained:0", "retained:1", "retained:2", "retained:0"],
  );
});

test("seed consumes each response and rejects application failures", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ ok: false, error: "storage failed" }),
  );
  await assert.rejects(
    seed({
      url: "https://benchmark.example",
      token: "test",
      target: "100",
      concurrency: "1",
    }),
    /storage failed/,
  );
});

test("claim measurements count actual jobs and consume response bodies", async (t) => {
  // Simulate slow response bodies so the timer must include their consumption.
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/health")) return Response.json({ ok: true });
    return {
      ok: true,
      async json() {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { ok: true, claimed: 1 };
      },
    };
  });
  const measured = await run({
    url: "https://benchmark.example",
    token: "test",
    operation: "retry",
    concurrency: "1",
    duration: "1",
  });
  assert.ok(measured.result.successes > 0);
  assert.deepEqual(
    { claimed: measured.claimedJobs, failures: measured.result.failures },
    { claimed: measured.result.successes, failures: 0 },
  );
  assert.ok(
    measured.result.latencyMs.min >= 10,
    "claim latency includes the response body",
  );
});
