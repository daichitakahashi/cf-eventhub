import { Hono } from "hono";

import api from "./api";
import { createHandler } from "./app";
import type { Env } from "./factory";

export const createWebConsole = ({
  dateFormatter,
}: {
  dateFormatter: Intl.DateTimeFormat;
}) =>
  new Hono<Env>()
    .route(
      "/",
      createHandler({
        dateFormatter,
      }),
    )
    .route("/api", api);
