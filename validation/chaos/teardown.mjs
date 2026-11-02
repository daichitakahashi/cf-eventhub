#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// This destroys only the fixed, dedicated resources in validation/chaos/wrangler.jsonc.
if (process.env.CHAOS_DESTROY !== "true") {
  throw new Error(
    "Set CHAOS_DESTROY=true to permanently delete the chaos resources and data",
  );
}
const baseUrl = process.env.CHAOS_URL;
const token =
  process.env.CHAOS_TOKEN ??
  (process.env.CHAOS_TOKEN_FILE
    ? (await readFile(process.env.CHAOS_TOKEN_FILE, "utf8")).trim()
    : undefined);
if (!baseUrl || !token)
  throw new Error("Set CHAOS_URL and CHAOS_TOKEN (or CHAOS_TOKEN_FILE)");
const config = JSON.parse(
  await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
);
const resource = "cf-eventhub-chaos";
if (
  config.name !== resource ||
  config.r2_buckets[0].bucket_name !== resource ||
  config.workflows[0].name !== resource ||
  config.queues.producers[0].queue !== resource
) {
  throw new Error("Unexpected resource configuration; refusing teardown");
}
let removed = 0;
while (true) {
  const response = await fetch(`${baseUrl}/cleanup-r2?runId=teardown`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`R2 cleanup: ${response.status} ${await response.text()}`);
  const body = await response.json();
  removed += body.removed;
  if (body.done) break;
}
console.log(`Removed ${removed} R2 objects`);
const wrangler = (...args) => {
  const result = spawnSync(
    "pnpm",
    ["--filter", "eventhub-chaos", "exec", "wrangler", ...args],
    { stdio: "inherit" },
  );
  if (result.status !== 0)
    throw new Error(`wrangler ${args[0]} failed: ${result.status}`);
};
wrangler("queues", "consumer", "remove", resource, resource);
// Deleting a Workflow also deletes its execution history/instances.
wrangler("workflows", "delete", resource);
const directory = resolve("validation/chaos/.wrangler/teardown");
await mkdir(directory, { recursive: true });
await writeFile(
  `${directory}/index.mjs`,
  `export default {
  fetch() {
    return new Response("chaos retired", { status: 410 });
  },
  queue(batch) {
    batch.ackAll();
  },
};
`,
);
await writeFile(
  `${directory}/wrangler.json`,
  JSON.stringify(
    {
      name: resource,
      main: "index.mjs",
      compatibility_date: config.compatibility_date,
      workers_dev: false,
      preview_urls: false,
      exports: Object.fromEntries(
        Object.keys(config.exports).map((name) => [
          name,
          { type: "durable-object", state: "deleted" },
        ]),
      ),
    },
    null,
    2,
  ),
);
// Tombstones permanently delete all three namespaces and every stored DO instance.
wrangler("deploy", "--config", `${directory}/wrangler.json`);
wrangler("delete", "--name", resource, "--force");
wrangler("queues", "delete", resource);
wrangler("r2", "bucket", "delete", resource);
console.log(
  "Deleted chaos Worker, DO namespaces/data, Workflow/instances, Queue, and R2 bucket",
);
