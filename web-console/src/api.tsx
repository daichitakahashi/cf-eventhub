import { vValidator } from "@hono/valibot-validator";
import * as v from "valibot";

import { factory } from "./factory";

const handler = factory
  .createApp()
  // Get timestamp of the latest event.
  .get("/events/latest", async (c) => {
    const events = await c.env.EVENTHUB.listEvents({
      maxItems: 1,
      orderBy: "CREATED_AT_DESC",
    });

    if (events.list.length === 0) {
      return c.json({ lastUpdatedAt: 0 });
    }
    const lastUpdatedAt = events.list[0].createdAt.getTime();
    return c.json({ lastUpdatedAt });
  })
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
      await c.env.EVENTHUB.retryDispatch({ dispatchId: id });
      return c.newResponse(null, {
        status: 200,
        headers: {
          "HX-Refresh": "true", // Force reload dispatches.
        },
      });
    },
  )
  // Create event.
  .post(
    "/events",
    vValidator(
      "form",
      v.object({
        payload: v.string(),
      }),
    ),
    async (c) => {
      try {
        const payload = JSON.parse(c.req.valid("form").payload);
        await c.env.EVENTHUB.putEvent([payload]);
        return c.newResponse(null, {
          status: 200,
          headers: {
            "HX-Redirect": "/", // Redirect to dispatches.
          },
        });
      } catch {
        return c.newResponse(null, {
          status: 200,
          headers: {
            "HX-Refresh": "true",
          },
        });
      }
    },
  );

export default handler;
