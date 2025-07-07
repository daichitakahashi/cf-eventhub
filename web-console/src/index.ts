import { Hono } from "hono";

import api from "./api";
import { createHandler } from "./app";
import type { Env } from "./factory";

export const createWebConsole = ({
  dateFormatter,
  color,
  environment,
}: {
  dateFormatter: Intl.DateTimeFormat;
  color?: `#${string}`;
  environment?: string;
}) =>
  new Hono<Env>()
    .route(
      "/",
      createHandler({
        pageSize: 10,
        dateFormatter,
        color,
        environment,
      }),
    )
    .route("/api", api);
