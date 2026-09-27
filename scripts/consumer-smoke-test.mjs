import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = path.join(root, "cf-eventhub");
const webConsoleDirectory = path.join(root, "web-console");
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "cf-eventhub-consumer-"),
);
const consumerDirectory = path.join(temporaryDirectory, "consumer");
const packageTarball = path.join(temporaryDirectory, "cf-eventhub.tgz");
const webConsoleTarball = path.join(temporaryDirectory, "web-console.tgz");

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

const readManifest = async (directory, packageName = "") =>
  JSON.parse(
    await readFile(
      path.join(directory, "node_modules", packageName, "package.json"),
      "utf8",
    ),
  );

try {
  const [typescriptVersion, wranglerVersion] = await Promise.all([
    installedVersion("typescript"),
    installedVersion("wrangler"),
  ]);

  run("pnpm", ["pack", "--out", packageTarball], packageDirectory);
  run("pnpm", ["pack", "--out", webConsoleTarball], webConsoleDirectory);

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
            "@cf-eventhub/web-console": "file:../web-console.tgz",
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
            skipLibCheck: true,
            noEmit: true,
            isolatedModules: true,
            jsx: "react-jsx",
            jsxImportSource: "hono/jsx",
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
  "exports": {
    "SmokeEventHub": { "type": "durable-object", "storage": "sqlite" },
    "EventHubRegistry": { "type": "durable-object", "storage": "sqlite" }
  },
  "queues": {
    "producers": [{ "binding": "EVENTS", "queue": "events" }]
  }
}
`,
    ),
    writeFile(
      path.join(consumerDirectory, "src", "index.ts"),
      `import { createWebConsole } from "@cf-eventhub/web-console";
import { env } from "cloudflare:workers";
import {
  EventHub,
  EventHubRegistry,
  type RoutingConfig,
  routeByConfig,
} from "cf-eventhub";

export { EventHubRegistry };

interface Env {
  EVENT_HUB: DurableObjectNamespace<SmokeEventHub>;
  EVENT_HUB_REGISTRY: DurableObjectNamespace<EventHubRegistry>;
  EVENTS: Queue;
}

const routingConfig: RoutingConfig<Env> = {
  routes: [
    {
      condition: { allOf: [] },
      destination: "EVENTS",
    },
  ],
};

export class SmokeEventHub extends EventHub<Env> {
  registry = env.EVENT_HUB_REGISTRY;
  routing = routeByConfig(env, routingConfig);
}

export default createWebConsole({
  eventHub: {
    binding: "EVENT_HUB",
  },
  registry: {
    binding: "EVENT_HUB_REGISTRY",
  },
  environment: "smoke-test",
});
`,
    ),
  ]);

  run("pnpm", ["install", "--no-frozen-lockfile"], consumerDirectory);

  const [installedPackage, installedWebConsole] = await Promise.all([
    readManifest(consumerDirectory, "cf-eventhub"),
    readManifest(consumerDirectory, "@cf-eventhub/web-console"),
  ]);
  assert.equal(installedPackage.name, "cf-eventhub");
  assert.equal(installedWebConsole.name, "@cf-eventhub/web-console");
  assert.equal(
    installedWebConsole.peerDependencies["cf-eventhub"],
    `^${installedPackage.version}`,
  );

  run("pnpm", ["exec", "wrangler", "types"], consumerDirectory);
  run("pnpm", ["exec", "tsc", "--noEmit"], consumerDirectory);
  run("pnpm", ["exec", "wrangler", "deploy", "--dry-run"], consumerDirectory);

  console.log("Consumer smoke test passed.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
