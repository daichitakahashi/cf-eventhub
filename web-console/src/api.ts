import { vValidator } from "@hono/valibot-validator";
import * as v from "valibot";

import { factory } from "./factory";

const handler = factory
  .createApp()
  // List dispatches.
  .get(
    "/dispatches",
    vValidator(
      "query",
      v.object({
        token: v.nullish(v.string()),
      }),
    ),
    async (c) => {
      const { token } = c.req.valid("query");
      const result = await c.env.EVENT_HUB.listDispatches({
        maxItems: 20,
        orderBy: "CREATED_AT_DESC",
        continuationToken: token || undefined,
      });

      // FIXME: Return HTML

      return c.json(result);
    },
  )
  // Retry dispatch.
  .post(
    "/dispatches/:id/retry",
    vValidator(
      "param",
      v.object({
        id: v.pipe(v.string(), v.minLength(1)),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid("param");
      //await c.env.EVENT_HUB.retryDispatch({ dispatchId: dispatchIds });
      console.log("dispatchId:", id);
      return c.newResponse(null, {
        status: 200,
        headers: {
          "HX-Refresh": "true", // Force reload dispatches.
        },
      });
    },
  )
  // Get event.
  .get(
    "/events/:id",
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

export default handler;
