import { vValidator } from "@hono/valibot-validator";
import { Hono } from "hono";
import * as v from "valibot";

import type { RpcEventHub } from "../../cf-eventhub/src/core/hub/rpc";

type Env = {
  Bindings: {
    EVENT_HUB: Service<RpcEventHub>;
  };
};

const app = new Hono<Env>()
  // List dispatches.
  .get(
    "/api/dispatches",
    vValidator(
      "query",
      v.object({
        max: v.nullish(v.pipe(v.number(), v.maxValue(100), v.minValue(1)), 10),
        orderBy: v.nullish(
          v.union([v.literal("CREATED_AT_ASC"), v.literal("CREATED_AT_DESC")]),
          "CREATED_AT_DESC",
        ),
        token: v.nullish(v.string()),
      }),
    ),
    async (c) => {
      const { max, orderBy, token } = c.req.valid("query");
      const result = await c.env.EVENT_HUB.listDispatches({
        maxItems: max,
        orderBy,
        continuationToken: token || undefined,
      });
      return c.json(result);
    },
  )

  // Get event.
  .get(
    "/api/events/:id",
    vValidator(
      "param",
      v.object({
        id: v.pipe(v.string(), v.minLength(1)),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid("param");
      const result = await c.env.EVENT_HUB.getEvent(id);
      if (!result) {
        return c.newResponse(null, 404);
      }
      return c.json(result.payload);
    },
  );

export default app;
