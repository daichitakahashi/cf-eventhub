import { vValidator } from "@hono/valibot-validator";
import { Fragment } from "hono/jsx";
import * as v from "valibot";

import { DispatchRow, LoadNextDispatches } from "./components/DispatchList";
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
      const result = await c.env.EVENTHUB.listDispatches({
        maxItems: 5,
        continuationToken: token || undefined,
        filterByStatus: undefined,
        orderBy: "CREATED_AT_DESC",
      });
      return c.html(
        <Fragment>
          {result.list.map((dispatch, i) => (
            <Fragment key={dispatch.id}>
              <DispatchRow
                dispatch={dispatch}
                formatDate={c.get("dateFormatter")}
              />
              {i === result.list.length - 1 && result.continuationToken && (
                <LoadNextDispatches
                  continuationToken={result.continuationToken}
                />
              )}
            </Fragment>
          ))}
        </Fragment>,
      );
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
      await c.env.EVENTHUB.retryDispatch({ dispatchId: id });
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
      const result = await c.env.EVENTHUB.getEvent(id);
      if (!result) {
        return c.newResponse(null, 404);
      }
      return c.text(JSON.stringify(result.payload, null, 2));
    },
  )
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
