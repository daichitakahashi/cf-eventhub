#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const OPERATIONS = new Set(["publish", "list", "retry"]);
const DESTINATIONS = new Set(["none", "queue", "r2", "workflow"]);

export const percentile = (sorted, value) => {
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((value / 100) * sorted.length) - 1),
  );
  return sorted[index];
};

export const summarize = ({ latencies, successes, failures, elapsedMs }) => {
  const sorted = latencies.toSorted((a, b) => a - b);
  const round = (value) => (value === null ? null : Number(value.toFixed(2)));
  return {
    requests: successes + failures,
    successes,
    failures,
    throughputPerSecond: Number(((successes * 1000) / elapsedMs).toFixed(2)),
    latencyMs: {
      min: round(sorted[0] ?? null),
      p50: round(percentile(sorted, 50)),
      p90: round(percentile(sorted, 90)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
      max: round(sorted.at(-1) ?? null),
    },
  };
};

const parseArgs = (argv) => {
  const [command = "run", ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${key ?? "end of input"}`);
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
};

const integerOption = (options, name, fallback, minimum = 1) => {
  const value = Number(options[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}`);
  }
  return value;
};

const request = async (url, token, init = {}) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  if (body.ok === false) throw new Error(JSON.stringify(body));
  return body;
};

const commonOptions = (options) => {
  const baseUrl = options.url?.replace(/\/$/, "");
  const token = options.token ?? process.env.BENCHMARK_TOKEN;
  if (!baseUrl) throw new Error("--url is required");
  if (!token) throw new Error("--token or BENCHMARK_TOKEN is required");
  return {
    baseUrl,
    token,
    prefix: options.prefix ?? `bench-${Date.now()}`,
    partitions: integerOption(options, "partitions", 1),
  };
};

const hubName = (prefix, partitions, sequence) =>
  `${prefix}:${sequence % partitions}`;

export const seedHubName = (prefix, partitions, batchStart) =>
  `${prefix}:${Math.floor(batchStart / 100) % partitions}`;

export const run = async (options) => {
  const common = commonOptions(options);
  const operation = options.operation ?? "publish";
  const destination = options.destination ?? "none";
  if (!OPERATIONS.has(operation)) throw new Error("invalid --operation");
  if (!DESTINATIONS.has(destination)) throw new Error("invalid --destination");
  const concurrency = integerOption(options, "concurrency", 10);
  const durationSeconds = integerOption(options, "duration", 30);
  const paddingBytes = integerOption(options, "padding-bytes", 0, 0);
  const deadline = performance.now() + durationSeconds * 1000;
  const latencies = [];
  let successes = 0;
  let failures = 0;
  let sequence = 0;
  let claimedJobs = 0;
  const errors = {};

  const execute = async () => {
    const current = sequence++;
    const hub = encodeURIComponent(
      hubName(common.prefix, common.partitions, current),
    );
    if (operation === "publish") {
      return request(
        `${common.baseUrl}/publish?hub=${hub}&destination=${destination}`,
        common.token,
        {
          method: "POST",
          body: JSON.stringify({
            sequence: current,
            padding: "x".repeat(paddingBytes),
          }),
        },
      );
    }
    if (operation === "list") {
      return request(`${common.baseUrl}/list?hub=${hub}&max=100`, common.token);
    }
    await request(
      `${common.baseUrl}/retry/prepare?hub=${hub}&count=1`,
      common.token,
      { method: "POST" },
    );
    const started = performance.now();
    const result = await request(
      `${common.baseUrl}/retry/process?hub=${hub}`,
      common.token,
      { method: "POST" },
    );
    if (result.claimed !== 1)
      throw new Error(`expected one claimed job, got ${result.claimed}`);
    claimedJobs += result.claimed;
    return { result, measuredMs: performance.now() - started };
  };

  const worker = async () => {
    while (performance.now() < deadline) {
      const started = performance.now();
      try {
        const result = await execute();
        successes += 1;
        latencies.push(result.measuredMs ?? performance.now() - started);
      } catch (error) {
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        errors[message] = (errors[message] ?? 0) + 1;
      }
    }
  };

  const startedAt = new Date().toISOString();
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = performance.now() - started;
  const health = await fetch(`${common.baseUrl}/health`).then((r) => r.json());
  return {
    metadata: {
      startedAt,
      loadGenerator: process.version,
      operation,
      destination: operation === "publish" ? destination : null,
      durationSeconds,
      concurrency,
      partitions: common.partitions,
      prefix: common.prefix,
      paddingBytes,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      latencyScope:
        operation === "retry"
          ? "claim-and-finalize RPC only; throughput includes prepare RPC"
          : "HTTP response body consumed",
      ...health,
    },
    result: summarize({ latencies, successes, failures, elapsedMs }),
    ...(operation === "retry" ? { claimedJobs } : {}),
    errors,
  };
};

export const seed = async (options) => {
  const common = commonOptions(options);
  const target = integerOption(options, "target", undefined);
  const concurrency = integerOption(options, "concurrency", 10);
  const paddingBytes = integerOption(options, "padding-bytes", 0, 0);
  let next = 0;
  let seeded = 0;
  const worker = async () => {
    while (true) {
      const start = next;
      next += 100;
      if (start >= target) return;
      const count = Math.min(100, target - start);
      const hub = encodeURIComponent(
        seedHubName(common.prefix, common.partitions, start),
      );
      await request(
        `${common.baseUrl}/seed?hub=${hub}&start=${start}&count=${count}&paddingBytes=${paddingBytes}&claims=${options.claims === "true"}`,
        common.token,
        { method: "POST" },
      );
      seeded += count;
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  return {
    seeded,
    partitions: common.partitions,
    prefix: common.prefix,
    elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
  };
};

export const cleanup = async (options) => {
  const common = commonOptions(options);
  const removed = await Promise.all(
    Array.from({ length: common.partitions }, async (_, partition) => {
      const hub = encodeURIComponent(`${common.prefix}:${partition}`);
      let count = 0;
      while (true) {
        const response = await request(
          `${common.baseUrl}/cleanup?hub=${hub}`,
          common.token,
          {
            method: "DELETE",
          },
        );
        count += response.removed;
        if (response.done) return count;
      }
    }),
  );
  return { removed: removed.reduce((sum, count) => sum + count, 0) };
};

export const main = async (argv = process.argv.slice(2)) => {
  const { command, options } = parseArgs(argv);
  const result =
    command === "run"
      ? await run(options)
      : command === "seed"
        ? await seed(options)
        : command === "cleanup"
          ? await cleanup(options)
          : (() => {
              throw new Error(`unknown command: ${command}`);
            })();
  console.log(JSON.stringify(result, null, 2));
  if (result.result?.failures > 0) process.exitCode = 1;
  return result;
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
