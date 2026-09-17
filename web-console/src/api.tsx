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
  c.redirect(c.var.buildUrl("/", { error: "invalid-payload" }));

const getRpcErrorDetails = (
  error: unknown,
): { errorCode?: string; errorMessage: string } => {
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  if (typeof error === "object" && error !== null) {
    try {
      const record = error as Record<string, unknown>;
      if (typeof record.code === "string") errorCode = record.code;
      if (typeof record.message === "string") errorMessage = record.message;
    } catch {
      // Fall through to the safe generic message below.
    }
  }

  if (!errorMessage) {
    try {
      errorMessage = String(error);
    } catch {
      errorMessage = "Unknown error";
    }
  }

  return { ...(errorCode ? { errorCode } : {}), errorMessage };
};

const redirectWithRpcError = (
  c: Context<Env>,
  operation: "publish" | "redrive",
  error: unknown,
) =>
  c.redirect(
    c.var.buildUrl("/", {
      error: `${operation}-failed`,
      ...getRpcErrorDetails(error),
    }),
  );

const handler = factory
  .createApp()
  .use(async (c, next) => {
    if (c.var.registryError) {
      return c.json({ error: "EventHub Registry unavailable" }, 503);
    }
    return next();
  })
  .post("/instances/delete", async (c) => {
    const instance = c.var.selectedInstance;
    if (!instance || c.var.requestedInstance !== instance.name) {
      return c.json({ error: "EventHub instance not found" }, 404);
    }
    if (instance.status !== "stale") {
      return c.json({ error: "Only stale instances can be deleted" }, 409);
    }
    try {
      await c.var.registry.delete(instance.name);
    } catch {
      return c.json({ error: "EventHub Registry unavailable" }, 503);
    }
    return c.redirect("/");
  })
  .get("/events/latest", async (c) => {
    const hub = c.var.getEventHub();
    if (!hub) {
      return c.json({ error: "EventHub instance not found" }, 404);
    }
    const list = await hub.list({
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
      const hub = c.var.getEventHub();
      if (!hub) {
        return c.json({ error: "EventHub instance not found" }, 404);
      }
      let retried: boolean;
      try {
        retried = await hub.redrive(c.req.valid("param").id);
      } catch (error) {
        return redirectWithRpcError(c, "redrive", error);
      }
      if (!retried) {
        return c.redirect(c.var.buildUrl("/", { error: "delivery-not-found" }));
      }
      return c.redirect(c.var.buildUrl("/"));
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
      const hub = c.var.getEventHub();
      if (!hub) {
        return c.json({ error: "EventHub instance not found" }, 404);
      }
      const parsed = parseEventPayload(c.req.valid("form").payload);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return redirectWithError(c);
      }
      try {
        await hub.publish(parsed as EventPayload);
      } catch (error) {
        return redirectWithRpcError(c, "publish", error);
      }
      return c.redirect(c.var.buildUrl("/"));
    },
  );

export default handler;
