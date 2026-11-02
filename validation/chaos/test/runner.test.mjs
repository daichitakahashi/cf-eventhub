import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A transport fixture tests the runner's timeout/reporting contract only. It
// does not simulate EventHub retries or replace the real deployed validation.
test("recovery timeout exits nonzero, disables faults and retains diagnostics", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eventhub-chaos-runner-"));
  const output = join(directory, "summary.json");
  let disabled = 0;
  let published = false;
  const coverage = ["QUEUE", "BUCKET", "WORKFLOW"].flatMap((destination) =>
    ["fail-before", "commit-then-fail"].map((mode) => ({
      destination,
      mode,
      outcome: "injected",
      count: 1,
    })),
  );
  const jobs = Array.from({ length: 30 }, (_, i) => ({
    id: `job${i}`,
    payloadId: `payload${Math.floor(i / 3)}`,
    destination: ["QUEUE", "BUCKET", "WORKFLOW"][i % 3],
    finalStatus: null,
    leaseToken: null,
  }));
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
      /* consume request body */
    }
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/disable") disabled++;
    if (path === "/publish") published = true;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        path === "/state"
          ? {
              hub: { jobs: published ? jobs : [], payloads: [] },
              faults: { coverage, config: [{ enabled: disabled ? 0 : 1 }] },
              receipts: [],
            }
          : { ok: true },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const child = spawn(
    process.execPath,
    [new URL("../run.mjs", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        CHAOS_URL: `http://127.0.0.1:${server.address().port}`,
        CHAOS_TOKEN: "test",
        CHAOS_RUN_ID: "timeout-test",
        CHAOS_PAYLOADS: "10",
        CHAOS_MAX_PAYLOADS: "10",
        CHAOS_MIN_COVERAGE: "1",
        CHAOS_RECOVERY_SECONDS: "1",
        CHAOS_OUTPUT: output,
      },
      stdio: "ignore",
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  const summary = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(
    {
      code,
      pass: summary.pass,
      error: summary.error,
      disabled: disabled >= 2,
      states: summary.finalDeliveryStates,
      injectionDisabled: summary.injectionDisabled,
    },
    {
      code: 1,
      pass: false,
      error: "Error: Recovery/reconciliation timeout",
      disabled: true,
      states: { pending: 30 },
      injectionDisabled: true,
    },
  );
  const diagnostics = JSON.parse(
    await readFile(join(directory, "summary.diagnostics.json"), "utf8"),
  );
  assert.equal(diagnostics.expected.length, 30);
});
