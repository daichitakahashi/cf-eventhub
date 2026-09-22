import { vValidator } from "@hono/valibot-validator";
import type { EventHubErrorCode, EventPayload } from "cf-eventhub";
import type { Context } from "hono";
import * as v from "valibot";

import { getEventsLastUpdatedAt, normalizeEvents } from "./eventhub";
import { type Env, factory } from "./factory";
import { getEventHubErrorCode } from "./operation-error";

const parseEventPayload = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const redirectWithError = (c: Context<Env>) =>
  c.redirect(c.var.buildUrl("/", { error: "invalid-payload" }));

const redirectWithRpcError = (
  c: Context<Env>,
  operation: "publish" | "redrive",
  error: unknown,
) => {
  const fragment = new URLSearchParams({ error: `${operation}-failed` });
  const code = getEventHubErrorCode(error);
  if (code) fragment.set("code", code);
  return c.redirect(`${c.var.buildUrl("/")}#${fragment}`);
};

const redirectWithResultError = (
  c: Context<Env>,
  operation: "publish" | "redrive",
  code: EventHubErrorCode,
) => {
  const fragment = new URLSearchParams({
    error: `${operation}-failed`,
    code,
  });
  return c.redirect(`${c.var.buildUrl("/")}#${fragment}`);
};

const handler = factory
  .createApp()
  .use(async (c, next) => {
    if (c.var.registryError) {
      if ("code" in c.var.registryError) {
        return c.json(
          {
            error: c.var.registryError.message,
            code: c.var.registryError.code,
          },
          503,
        );
      }
      return c.json({ error: "EventHub Registry unavailable" }, 503);
    }
    return next();
  })
  .get("/instances/search", async (c) => {
    const status = c.req.query("status") ?? "active";
    const search = c.req.query("search") ?? "";
    const cursor = c.req.query("cursor");
    if ((status !== "active" && status !== "stale") || search.length > 200) {
      return c.json({ error: "Invalid instance search" }, 400);
    }
    try {
      const result = await c.var.registry.list({
        status,
        nameContains: search,
        cursor,
        max: 50,
      });
      if (!result.ok) {
        return c.json(
          { error: result.error.message, code: result.error.code },
          result.error.code === "INVALID_CURSOR" ? 400 : 503,
        );
      }
      return c.json(result.value);
    } catch {
      return c.json({ error: "EventHub Registry unavailable" }, 503);
    }
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
      const result = await c.var.registry.delete(instance.name);
      if (!result.ok) {
        return c.json(
          { error: result.error.message, code: result.error.code },
          503,
        );
      }
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
    let result: Awaited<ReturnType<typeof hub.list>>;
    try {
      result = await hub.list({ max: 10, order: "desc" });
    } catch {
      return c.json({ error: "EventHub instance unavailable" }, 502);
    }
    if (!result.ok) {
      return c.json(
        { error: result.error.message, code: result.error.code },
        502,
      );
    }
    return c.json({
      lastUpdatedAt: getEventsLastUpdatedAt(normalizeEvents(result.value)),
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
      let result: Awaited<ReturnType<typeof hub.redrive>>;
      try {
        result = await hub.redrive(c.req.valid("param").id);
      } catch (error) {
        return redirectWithRpcError(c, "redrive", error);
      }
      if (!result.ok) {
        return redirectWithResultError(c, "redrive", result.error.code);
      }
      if (!result.value) {
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
        const result = await hub.publish(parsed as EventPayload);
        if (!result.ok) {
          return redirectWithResultError(c, "publish", result.error.code);
        }
      } catch (error) {
        return redirectWithRpcError(c, "publish", error);
      }
      return c.redirect(c.var.buildUrl("/"));
    },
  );

export default handler;
