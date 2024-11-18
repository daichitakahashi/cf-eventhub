import { Hono } from "hono";

import type { Env } from "./factory";
import api from "./api";
import app from "./app";

const webConsole = new Hono<Env>().route("/", app).route("/api", api);

export default webConsole;
