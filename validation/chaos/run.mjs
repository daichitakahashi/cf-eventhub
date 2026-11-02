import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { coverageCounts, covered, reconcile } from "./reconcile.mjs";

const baseUrl = process.env.CHAOS_URL;
const token =
  process.env.CHAOS_TOKEN ??
  (process.env.CHAOS_TOKEN_FILE
    ? (await readFile(process.env.CHAOS_TOKEN_FILE, "utf8")).trim()
    : undefined);
if (!baseUrl || !token)
  throw new Error("Set CHAOS_URL and CHAOS_TOKEN or CHAOS_TOKEN_FILE");
const positive = (name, fallback, maximum) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`Invalid ${name}`);
  return value;
};
const runId = process.env.CHAOS_RUN_ID ?? `run-${Date.now()}`;
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId))
  throw new Error("Invalid CHAOS_RUN_ID");
const seed = positive("CHAOS_SEED", 193, 0xffffffff);
const minimum = positive("CHAOS_MIN_COVERAGE", 3, 10000);
const minPayloads = positive("CHAOS_PAYLOADS", 100, 10000);
const maxPayloads = positive("CHAOS_MAX_PAYLOADS", 1000, 10000);
if (maxPayloads < minPayloads)
  throw new Error("CHAOS_MAX_PAYLOADS < CHAOS_PAYLOADS");
const chaosTimeoutMs = positive("CHAOS_TIMEOUT_SECONDS", 300, 3600) * 1000;
const recoveryTimeoutMs = positive("CHAOS_RECOVERY_SECONDS", 600, 3600) * 1000;
const weights = JSON.parse(
  process.env.CHAOS_WEIGHTS ??
    '{"pass":1,"fail-before":4,"commit-then-fail":4}',
);
const output = resolve(
  process.env.CHAOS_OUTPUT ??
    `validation/chaos/.wrangler/results/${runId}.json`,
);
const request = async (
  path,
  body,
  method = body === undefined ? "GET" : "POST",
) => {
  const response = await fetch(
    `${baseUrl}${path}${path.includes("?") ? "&" : "?"}runId=${encodeURIComponent(runId)}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(
      `${path}: HTTP ${response.status}: ${await response.text()}`,
    );
  return response.json();
};
const collectObjects = async () => {
  const objects = [];
  let cursor;
  do {
    const page = await request(
      `/objects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    objects.push(...page.objects);
    cursor = page.cursor;
  } while (cursor);
  return objects;
};
const collectWorkflows = async (expected) => {
  const ids = expected
    .filter((j) => j.destination === "WORKFLOW")
    .map((j) => j.id);
  const instances = [];
  for (let i = 0; i < ids.length; i += 20)
    instances.push(...(await request("/workflows", ids.slice(i, i + 20))));
  return instances;
};
const summary = {
  runId,
  date: new Date().toISOString(),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  sourceDirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  ),
  cfEventhubVersion: JSON.parse(
    await readFile(
      new URL("../../cf-eventhub/package.json", import.meta.url),
      "utf8",
    ),
  ).version,
  compatibilityDate: JSON.parse(
    await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
  ).compatibility_date,
  config: {
    seed,
    weights,
    minimumCoverage: minimum,
    minPayloads,
    maxPayloads,
    chaosTimeoutMs,
    recoveryTimeoutMs,
    retry: {
      initialRetryDelayMs: 1000,
      maxRetryDelayMs: 5000,
      maxDeliveryRetries: 1000,
      deliveryAttemptLeaseMs: 30000,
      alarmBatchSize: 100,
    },
    includeDeliveryMetadata: true,
  },
  pass: false,
};
let setup = false;
let state;
let expected = [];
let published = 0;
let recoveryStart;
try {
  await request("/setup", { seed, weights });
  setup = true;
  const chaosStart = Date.now();
  state = await request("/state");
  while (published < minPayloads || !covered(state.faults, minimum)) {
    if (Date.now() - chaosStart > chaosTimeoutMs)
      throw new Error("Chaos coverage timeout");
    if (published < maxPayloads) {
      const count = Math.min(10, maxPayloads - published);
      // No automatic HTTP retry: a lost publish acknowledgement is an explicit
      // failure, avoiding accidental duplicate event indices in the expected set.
      await request("/publish", { start: published, count });
      published += count;
    }
    await delay(1000);
    state = await request("/state");
    console.log(
      JSON.stringify({
        phase: "chaos",
        published,
        coverage: coverageCounts(state.faults),
      }),
    );
  }
  // Persist the authoritative job set BEFORE disabling faults. Subsequent polls
  // can never silently replace the expected set with a smaller final set.
  expected = state.hub.jobs.map(({ id, payloadId, destination }) => ({
    id,
    payloadId,
    destination,
  }));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    `${output.replace(/\.json$/, "")}.expected.json`,
    JSON.stringify({ runId, published, expected }, null, 2),
  );
  summary.chaosDurationMs = Date.now() - chaosStart;
  await request("/disable", {});
  recoveryStart = Date.now();
  const deadline = recoveryStart + recoveryTimeoutMs;
  let stableSince;
  while (true) {
    state = await request("/state");
    const inFlight = state.faults.coverage.some(
      (r) => r.outcome === "in-flight" && r.count > 0,
    );
    const done =
      state.hub.jobs.length === expected.length &&
      state.hub.jobs.every(
        (j) => j.finalStatus === "completed" && j.leaseToken === null,
      );
    if (!inFlight && done) {
      const result = reconcile({
        runId,
        published,
        expected,
        state,
        objects: await collectObjects(),
        workflows: await collectWorkflows(expected),
      });
      summary.reconciliation = result;
      if (result.pass) {
        stableSince ??= Date.now();
        // Observe a quiet window for late Queue receipts and Workflow execution.
        if (Date.now() - stableSince >= 10000) {
          summary.pass = true;
          break;
        }
      } else stableSince = undefined;
    }
    if (Date.now() > deadline)
      throw new Error("Recovery/reconciliation timeout");
    await delay(2000);
  }
} catch (error) {
  summary.error = String(error);
} finally {
  if (setup) {
    try {
      await request("/disable", {});
      state = await request("/state");
    } catch (error) {
      summary.disableError = String(error);
      summary.pass = false;
    }
  }
  summary.published = published;
  summary.expectedJobs = expected.length;
  if (recoveryStart) summary.recoveryDurationMs = Date.now() - recoveryStart;
  if (state) {
    summary.coverage = coverageCounts(state.faults);
    summary.faults = state.faults;
    summary.finalDeliveryStates = state.hub.jobs.reduce((counts, job) => {
      const status = job.finalStatus ?? (job.leaseToken ? "leased" : "pending");
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {});
    summary.injectionDisabled =
      state.faults.config.length === 1 && state.faults.config[0].enabled === 0;
    if (!summary.injectionDisabled) summary.pass = false;
    if (!covered(state.faults, minimum)) summary.pass = false;
    if (!summary.pass) {
      // Full diagnostics stay in the ignored local output directory, not Git.
      await mkdir(dirname(output), { recursive: true });
      await writeFile(
        `${output.replace(/\.json$/, "")}.diagnostics.json`,
        JSON.stringify({ state, expected }, null, 2),
      );
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}
if (!summary.pass) process.exitCode = 1;
