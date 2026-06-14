import { vValidator } from "@hono/valibot-validator";
import type { Context } from "hono";
import type { EventPayload } from "eventhub/src";
import * as v from "valibot";

import { type Env, factory } from "./factory";
import { getHub, normalizeEvents, toTimestamp } from "./eventhub";

const parseEventPayload = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const redirectWithError = (c: Context<Env>) => c.redirect("/?error=invalid-payload");

const handler = factory
  .createApp()
  .get("/events/latest", async (c) => {
    const list = await getHub(c.env, c.var.hubName).list({
      max: 1,
      order: "desc",
    });
    const latestEvent = normalizeEvents(list)[0];
    return c.json({
      lastUpdatedAt: toTimestamp(latestEvent?.createdAt),
    });
  })
  .post(
    "/dispatches/:id/retry",
    vValidator(
      "param",
      v.object({
        id: v.pipe(v.string(), v.minLength(1)),
      }),
    ),
    async (c) => {
      const retried = await getHub(c.env, c.var.hubName).redrive(
        c.req.valid("param").id,
      );
      if (!retried) {
        return c.redirect("/?error=dispatch-not-found");
      }
      return c.redirect("/");
    },
  )
  .post(
    "/events",
    vValidator(
      "form",
      v.object({
        payload: v.pipe(v.string(), v.minLength(1)),
      }),
    ),
    async (c) => {
      const parsed = parseEventPayload(c.req.valid("form").payload);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return redirectWithError(c);
      }
      await getHub(c.env, c.var.hubName).publish(parsed as EventPayload);
      return c.redirect("/");
    },
  );

export default handler;
