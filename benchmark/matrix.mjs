#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cleanup, run, seed } from "./load.mjs";

const baseUrl = process.env.BENCHMARK_URL;
const token =
  process.env.BENCHMARK_TOKEN ??
  (process.env.BENCHMARK_TOKEN_FILE
    ? (await readFile(process.env.BENCHMARK_TOKEN_FILE, "utf8")).trim()
    : undefined);
if (!baseUrl || !token)
  throw new Error(
    "Set BENCHMARK_URL and BENCHMARK_TOKEN (or BENCHMARK_TOKEN_FILE)",
  );
const series = process.env.BENCHMARK_SERIES ?? `baseline-${Date.now()}`;
const output = process.env.BENCHMARK_OUTPUT ?? `benchmark/results/${series}`;
const duration = process.env.BENCHMARK_DURATION ?? "30";
const common = {
  url: baseUrl,
  token,
  concurrency: "20",
  duration,
  partitions: "1",
};
await mkdir(output, { recursive: true });
const save = async (name, value) =>
  writeFile(`${output}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
const stats = async (options) =>
  Promise.all(
    Array.from({ length: Number(options.partitions) }, async (_, partition) => {
      const response = await fetch(
        `${baseUrl}/stats?hub=${encodeURIComponent(`${options.prefix}:${partition}`)}&claims=${options.operation === "retry"}`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok)
        throw new Error(`stats: ${response.status} ${await response.text()}`);
      return response.json();
    }),
  );
const retainedOnly = process.env.BENCHMARK_PHASE === "retained";
const cases = retainedOnly
  ? JSON.parse(await readFile(`${output}/cases.json`, "utf8"))
  : [];
const measure = async (name, options) => {
  const config = { ...common, ...options };
  const before = await stats(config);
  const measured = await run(config);
  // Preserve timed results even if diagnostic reads subsequently time out.
  await save(name, { before, ...measured });
  const after = await stats(config);
  const record = { before, ...measured, after };
  await save(name, record);
  cases.push({ name, ...config, token: undefined, url: undefined });
  await save("cases", cases);
  console.log(name, JSON.stringify(measured.result));
  if (measured.result.failures > 0)
    throw new Error(`${name}: failed requests; see raw results`);
  if (
    config.operation === "retry" &&
    measured.claimedJobs !== measured.result.successes
  )
    throw new Error(`${name}: claim count differs from successful cycles`);
};

for (const partitions of retainedOnly ? [] : [1, 10, 100]) {
  const config = {
    ...common,
    prefix: `${series}-p${partitions}`,
    partitions: String(partitions),
    operation: "publish",
  };
  await save(`warmup-p${partitions}`, await run({ ...config, duration: "5" }));
  await measure(`publish-p${partitions}`, config);
}
for (const destination of retainedOnly ? [] : ["queue", "r2", "workflow"]) {
  const config = {
    ...common,
    prefix: `${series}-${destination}`,
    partitions: "10",
    operation: "publish",
    destination,
  };
  await save(`warmup-${destination}`, await run({ ...config, duration: "5" }));
  await measure(`publish-${destination}`, config);
  const deadline =
    Date.now() + Number(process.env.BENCHMARK_DRAIN_SECONDS ?? "600") * 1000;
  let state;
  do {
    state = await stats(config);
    if (
      state.every((hub) =>
        hub.jobs.every((job) => job.final_status === "completed"),
      )
    )
      break;
    if (
      state.some((hub) => hub.jobs.some((job) => job.final_status === "failed"))
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  await save(`delivery-${destination}`, state);
  if (
    state.some((hub) =>
      hub.jobs.some((job) => job.final_status !== "completed"),
    )
  )
    throw new Error(`${destination}: delivery did not complete`);
}
for (const target of [100, 10_000, 100_000]) {
  const config = { ...common, prefix: `${series}-retained-${target}` };
  await save(
    `seed-${target}`,
    await seed({ ...config, target: String(target), concurrency: "5" }),
  );
  await save(
    `seed-claims-${target}`,
    await seed({
      ...config,
      target: String(target),
      concurrency: "5",
      claims: "true",
    }),
  );
  await measure(`list-${target}`, { ...config, operation: "list" });
  await measure(`claim-${target}`, { ...config, operation: "retry" });
  await measure(`publish-${target}`, { ...config, operation: "publish" });
}
await save("environment", {
  series,
  baseUrl,
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  durationSeconds: Number(duration),
  concurrency: 20,
  warmupSeconds: 5,
  completedAt: new Date().toISOString(),
});
if (process.env.BENCHMARK_CLEANUP === "true") {
  for (const prefix of new Set(cases.map((entry) => entry.prefix))) {
    const config = cases.find((entry) => entry.prefix === prefix);
    await save(
      `cleanup-${prefix}`,
      await cleanup({ ...common, prefix, partitions: config.partitions }),
    );
  }
}
