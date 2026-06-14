import { Hono } from "hono";

import api from "./api";
import { createHandler } from "./app";
import type { Env } from "./factory";

type Options = Parameters<typeof createHandler>[0];

export const createWebConsole = (opts: Options) =>
  new Hono<Env>().route("/", createHandler(opts)).route("/api", api);
