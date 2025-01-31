import chalk from "chalk";

import { tryConnect } from "./connect.mjs";
import { exec, waitExit } from "./process.mjs";

const eventHub = exec("pnpm dev --port 3001 --inspector-port 3002", {
  name: "dev-eventhub",
  dir: "internal/dev-eventhub",
  chalk: chalk.blue,
});

await tryConnect(10, 3001);

const webConsole = exec("pnpm dev --port 3011 --inspector-port 3012", {
  name: "web-console",
  dir: "web-console",
  chalk: chalk.yellowBright,
});

const stableHandler = exec("pnpm dev --port 3021 --inspector-port 3022", {
  name: "stable-handler",
  dir: "internal/stable-handler",
  chalk: chalk.gray,
});
const flakyHandler = exec("pnpm dev --port 3031 --inspector-port 3032", {
  name: "flaky-handler",
  dir: "internal/flaky-handler",
  chalk: chalk.magentaBright,
});
const producerHandler = exec("pnpm dev --port 3041 --inspector-port 3042", {
  name: "producer-handler",
  dir: "internal/producer-handler",
  chalk: chalk.green,
});

await waitExit(async () => {
  console.log("Exiting...");

  eventHub.process.stdin.write("x");
  stableHandler.process.stdin.write("x");
  flakyHandler.process.stdin.write("x");
  producerHandler.process.stdin.write("x");
  webConsole.process.stdin.write("x");

  await Promise.all([
    eventHub.exit,
    stableHandler.exit,
    flakyHandler.exit,
    producerHandler.exit,
    webConsole.exit,
  ]);
});
process.exit(0);
