import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = path.join(root, "cf-eventhub");
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "cf-eventhub-consumer-"),
);
const consumerDirectory = path.join(temporaryDirectory, "consumer");
const tarball = path.join(temporaryDirectory, "cf-eventhub.tgz");

const run = (command, args, cwd) => {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
};

const installedVersion = async (packageName) => {
  const manifest = JSON.parse(
    await readFile(
      path.join(packageDirectory, "node_modules", packageName, "package.json"),
      "utf8",
    ),
  );
  return manifest.version;
};

try {
  const [typescriptVersion, wranglerVersion] = await Promise.all([
    installedVersion("typescript"),
    installedVersion("wrangler"),
  ]);

  run("pnpm", ["pack", "--out", tarball], packageDirectory);

  await mkdir(path.join(consumerDirectory, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "cf-eventhub-consumer-smoke-test",
          private: true,
          type: "module",
          dependencies: {
            "cf-eventhub": "file:../cf-eventhub.tgz",
          },
          devDependencies: {
            typescript: typescriptVersion,
            wrangler: wranglerVersion,
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      path.join(consumerDirectory, "pnpm-workspace.yaml"),
      `packages: []

linkWorkspacePackages: false

allowBuilds:
  esbuild: true
  workerd: true
`,
    ),
    writeFile(
      path.join(consumerDirectory, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            lib: ["ESNext"],
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            isolatedModules: true,
            types: ["./worker-configuration.d.ts"],
          },
          include: ["worker-configuration.d.ts", "src/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      path.join(consumerDirectory, "wrangler.jsonc"),
      `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "cf-eventhub-consumer-smoke-test",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-11",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "EVENT_HUB", "class_name": "SmokeEventHub" },
      { "name": "EVENT_HUB_REGISTRY", "class_name": "EventHubRegistry" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SmokeEventHub"] },
    { "tag": "v2", "new_sqlite_classes": ["EventHubRegistry"] }
  ],
  "queues": {
    "producers": [{ "binding": "EVENTS", "queue": "events" }]
  }
}
`,
    ),
    writeFile(
      path.join(consumerDirectory, "src", "index.ts"),
      `import { env } from "cloudflare:workers";
import { EventHub, EventHubRegistry, routeByConfig } from "cf-eventhub";

export { EventHubRegistry };

interface Env {
  EVENT_HUB: DurableObjectNamespace<SmokeEventHub>;
  EVENT_HUB_REGISTRY: DurableObjectNamespace<EventHubRegistry>;
  EVENTS: Queue;
}

export class SmokeEventHub extends EventHub<Env> {
  registry = env.EVENT_HUB_REGISTRY;
  routing = routeByConfig(env, {
    routes: [
      {
        condition: { allOf: [] },
        destination: "EVENTS",
      },
    ],
  });
}

export default {
  fetch() {
    return new Response("ok");
  },
} satisfies ExportedHandler<Env>;
`,
    ),
  ]);

  run("pnpm", ["install", "--no-frozen-lockfile"], consumerDirectory);
  run("pnpm", ["exec", "wrangler", "types"], consumerDirectory);
  run("pnpm", ["exec", "tsc", "--noEmit"], consumerDirectory);
  run("pnpm", ["exec", "wrangler", "deploy", "--dry-run"], consumerDirectory);

  console.log("Consumer smoke test passed.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
