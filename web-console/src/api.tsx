import { vValidator } from "@hono/valibot-validator";
import type { EventPayload } from "cf-eventhub";
import type { Context } from "hono";
import * as v from "valibot";

import { getEventsLastUpdatedAt, normalizeEvents } from "./eventhub";
import { type Env, factory } from "./factory";

const parseEventPayload = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const redirectWithError = (c: Context<Env>) =>
  c.redirect("/?error=invalid-payload");

const handler = factory
  .createApp()
  .get("/events/latest", async (c) => {
    const list = await c.var.getEventHub().list({
      max: 10,
      order: "desc",
    });
    return c.json({
      lastUpdatedAt: getEventsLastUpdatedAt(normalizeEvents(list)),
    });
  })
  .post(
    "/delivery-jobs/:id/retry",
    vValidator(
      "param",
      v.object({
        id: v.pipe(v.string(), v.minLength(1)),
      }),
    ),
    async (c) => {
      const retried = await c.var
        .getEventHub()
        .redrive(c.req.valid("param").id);
      if (!retried) {
        return c.redirect("/?error=delivery-not-found");
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
      await c.var.getEventHub().publish(parsed as EventPayload);
      return c.redirect("/");
    },
  );

export default handler;
