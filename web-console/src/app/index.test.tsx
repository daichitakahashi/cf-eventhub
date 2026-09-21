import type {
  EventHub,
  EventHubInstance,
  EventHubRegistry,
  ListResult,
  Result,
} from "cf-eventhub";
import { describe, expect, test, vi } from "vitest";

import { createWebConsole } from "../index";

const instance = (
  name: string,
  status: EventHubInstance["status"] = "active",
): EventHubInstance => ({
  name,
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt:
    status === "stale"
      ? "2025-01-01T00:00:00.000Z"
      : "2026-09-01T00:00:00.000Z",
  deletedAt: status === "deleted" ? "2026-09-02T00:00:00.000Z" : null,
  status,
});

const emptyList = (): ListResult => ({ payloads: [] });

const setup = ({
  active = [instance("alpha"), instance("beta")],
  stale = [instance("old", "stale")],
}: {
  active?: EventHubInstance[];
  stale?: EventHubInstance[];
} = {}) => {
  const hubs = new Map(
    [...active, ...stale].map(({ name }) => [
      name,
      {
        list: vi.fn(
          async (_options?: unknown): Promise<Result<ListResult>> => ({
            ok: true,
            value: emptyList(),
          }),
        ),
        publish: vi.fn(async (): Promise<Result> => ({ ok: true })),
        redrive: vi.fn(
          async (): Promise<Result<boolean>> => ({
            ok: true,
            value: true,
          }),
        ),
      },
    ]),
  );
  const eventHubGetByName = vi.fn((name: string) => hubs.get(name));
  const registryList = vi.fn(
    async ({ status }: { status?: EventHubInstance["status"] } = {}) => ({
      ok: true as const,
      value: {
        instances:
          status === "stale" ? stale : status === "deleted" ? [] : active,
      },
    }),
  );
  const registryGet = vi.fn(async (name: string) => {
    return {
      ok: true as const,
      value:
        [...active, ...stale].find((candidate) => candidate.name === name) ??
        null,
    };
  });
  const registryDelete = vi.fn(async () => ({
    ok: true as const,
    value: true,
  }));
  const bindings = {
    EVENT_HUB: {
      getByName: eventHubGetByName,
    } as unknown as DurableObjectNamespace<EventHub>,
    EVENT_HUB_REGISTRY: {
      getByName: vi.fn(() => ({
        get: registryGet,
        list: registryList,
        delete: registryDelete,
      })),
    } as unknown as DurableObjectNamespace<EventHubRegistry>,
  };
  return {
    app: createWebConsole({}),
    bindings,
    hubs,
    eventHubGetByName,
    registryList,
    registryGet,
    registryDelete,
  };
};

describe("EventHub instance discovery", () => {
  test("selects the first active instance when the query is omitted", async () => {
    const { app, bindings, eventHubGetByName } = setup();
    const response = await app.request("http://localhost/", {}, bindings);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(eventHubGetByName).toHaveBeenCalledWith("alpha");
    expect(html).toContain('<option value="alpha" selected="">');
    expect(html).not.toContain('value="old"');
  });

  test("shows and labels stale instances only when requested", async () => {
    const { app, bindings } = setup();
    const response = await app.request(
      "http://localhost/?instance=old&showStale=1",
      {},
      bindings,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<option value="old" selected="">');
    expect(html).toContain("old (stale; last seen 2025-01-01T00:00:00.000Z)");
    expect(html).toContain(
      'type="checkbox" name="showStale" value="1" checked=""',
    );
    expect(html).not.toContain(
      '<input type="hidden" name="instance" value="old"',
    );
  });

  test("renders Show stale as an unchecked checkbox by default", async () => {
    const { app, bindings } = setup();
    const response = await app.request("http://localhost/", {}, bindings);
    const html = await response.text();

    expect(html).toContain('type="checkbox" name="showStale" value="1"');
    expect(html).not.toContain(
      'type="checkbox" name="showStale" value="1" checked=""',
    );
    expect(html).toContain(
      '<input type="hidden" name="instance" value="alpha"',
    );
  });

  test("does not resolve unknown or deleted query names", async () => {
    const { app, bindings, eventHubGetByName } = setup();
    const response = await app.request(
      "http://localhost/?instance=deleted-or-unknown&showStale=1",
      {},
      bindings,
    );

    expect(response.status).toBe(404);
    expect(eventHubGetByName).not.toHaveBeenCalled();
    expect(await response.text()).toContain("Select an EventHub instance");
  });

  test("renders a useful empty state without resolving an EventHub", async () => {
    const { app, bindings, eventHubGetByName } = setup({
      active: [],
      stale: [],
    });
    const response = await app.request("http://localhost/", {}, bindings);

    expect(response.status).toBe(200);
    expect(eventHubGetByName).not.toHaveBeenCalled();
    expect(await response.text()).toContain("No EventHub instances found");
  });

  test("renders a distinct Registry failure state", async () => {
    const configured = setup();
    configured.bindings.EVENT_HUB_REGISTRY = {
      getByName: () => ({
        list: async () => {
          throw new Error("registry offline");
        },
      }),
    } as unknown as DurableObjectNamespace<EventHubRegistry>;
    const response = await configured.app.request(
      "http://localhost/",
      {},
      configured.bindings,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Registry unavailable");
  });

  test("renders a distinct selected-instance failure state", async () => {
    const configured = setup();
    configured.hubs.get("alpha")?.list.mockRejectedValue(new Error("offline"));
    const response = await configured.app.request(
      "http://localhost/?instance=alpha",
      {},
      configured.bindings,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("EventHub instance unavailable");
  });
});

describe("EventHub instance URL state", () => {
  test("preserves instance in pagination, polling, creation, and redrive URLs", async () => {
    const configured = setup({ active: [instance("tenant:acme")] });
    const hub = configured.hubs.get("tenant:acme");
    if (!hub) throw new Error("test hub not found");
    hub.list
      .mockResolvedValueOnce({
        ok: true,
        value: {
          payloads: [
            {
              payloadId: "payload-1",
              createdAt: "2026-09-01T00:00:00.000Z",
              payload: { hello: "world" },
              deliveryJobs: [
                {
                  id: "job-1",
                  payloadId: "payload-1",
                  destination: "QUEUE",
                  createdAt: "2026-09-01T00:00:00.000Z",
                  failedAttemptCount: 0,
                  lastFailedAt: null,
                  lastError: null,
                  nextRetryAt: "2026-09-01T00:00:10.000Z",
                  finalStatus: "failed",
                  finalizedAt: "2026-09-01T00:00:20.000Z",
                  failureReportedAt: null,
                },
              ],
            },
          ],
          cursor: "next-cursor",
        },
      })
      .mockResolvedValueOnce({ ok: true, value: emptyList() });
    const response = await configured.app.request(
      "http://localhost/?instance=tenant%3Aacme",
      {},
      configured.bindings,
    );
    const html = await response.text();

    expect(html).toContain('action="/api/events?instance=tenant%3Aacme"');
    expect(html).toContain("/api/events/latest?instance=tenant%3Aacme");
    expect(html).toContain(
      'action="/api/delivery-jobs/job-1/retry?instance=tenant%3Aacme"',
    );
    expect(html).toContain(
      'href="/?instance=tenant%3Aacme&amp;cursor=next-cursor"',
    );
  });

  test("routes publish and redirects back to the selected instance", async () => {
    const { app, bindings, hubs, registryGet, registryList } = setup();
    const response = await app.request(
      "http://localhost/api/events?instance=beta",
      {
        method: "POST",
        body: new URLSearchParams({ payload: '{"kind":"test"}' }),
      },
      bindings,
    );

    expect(hubs.get("beta")?.publish).toHaveBeenCalledWith({ kind: "test" });
    expect(hubs.get("alpha")?.publish).not.toHaveBeenCalled();
    expect(registryGet).toHaveBeenCalledExactlyOnceWith("beta");
    expect(registryList).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?instance=beta");
  });

  test("displays a coded publish error on the selected instance", async () => {
    const configured = setup();
    configured.hubs.get("beta")?.publish.mockResolvedValue({
      ok: false,
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message:
          "eventhub: Queue message size 128001 bytes exceeds limit of 128000 bytes",
      },
    });

    const response = await configured.app.request(
      "http://localhost/api/events?instance=beta",
      {
        method: "POST",
        body: new URLSearchParams({ payload: '{"kind":"test"}' }),
      },
      configured.bindings,
    );
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const redirectUrl = new URL(location ?? "/", "http://localhost");
    expect(Object.fromEntries(redirectUrl.searchParams)).toStrictEqual({
      instance: "beta",
    });
    expect(redirectUrl.hash).toBe(
      "#error=publish-failed&code=PAYLOAD_TOO_LARGE",
    );
    expect(location).not.toContain("128001");

    const page = await configured.app.request(
      `${redirectUrl.origin}${redirectUrl.pathname}${redirectUrl.search}`,
      {},
      configured.bindings,
    );
    const html = await page.text();
    expect(html).toContain('id="operation-error"');
    expect(html).toContain("window.location.hash.slice(1)");
    expect(html).toContain("Failed to publish event.");
    expect(html).toContain(
      "The event exceeds the 128,000-byte Cloudflare Queues message size limit.",
    );
    expect(html).toContain("window.history.replaceState");
  });

  test("warns when a create-event payload exceeds the Queue message limit", async () => {
    const { app, bindings } = setup();
    const response = await app.request("http://localhost/", {}, bindings);
    const html = await response.text();

    expect(html).toContain('<output id="queue-size-warning"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(
      "Warning: This payload exceeds the 128 KB Cloudflare Queues message size limit.",
    );
    expect(html).toContain("queueSizeWarning.hidden = bytes <= 128000");
    expect(html).toContain("const textEncoder = new TextEncoder()");
    expect(html).toContain(
      "const bytes = textEncoder.encode(JSON.stringify(payload)).byteLength",
    );
    expect(html).toContain(
      'createPayload.addEventListener("input", updateQueueSizeWarning)',
    );
    expect(html).toContain("updateQueueSizeWarning();");
  });

  test("routes redrive without listing Registry instances", async () => {
    const { app, bindings, hubs, registryGet, registryList } = setup();
    const response = await app.request(
      "http://localhost/api/delivery-jobs/job-1/retry?instance=beta",
      { method: "POST" },
      bindings,
    );

    expect(hubs.get("beta")?.redrive).toHaveBeenCalledExactlyOnceWith("job-1");
    expect(registryGet).toHaveBeenCalledExactlyOnceWith("beta");
    expect(registryList).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?instance=beta");
  });

  test("does not expose unexpected redrive error details in the URL", async () => {
    const configured = setup();
    configured.hubs.get("beta")?.redrive.mockRejectedValue({
      code: "INTERNAL_SECRET",
      message: "storage credentials were rejected",
    });

    const response = await configured.app.request(
      "http://localhost/api/delivery-jobs/job-1/retry?instance=beta",
      { method: "POST" },
      configured.bindings,
    );
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const redirectUrl = new URL(location ?? "/", "http://localhost");
    expect(Object.fromEntries(redirectUrl.searchParams)).toStrictEqual({
      instance: "beta",
    });
    expect(redirectUrl.hash).toBe("#error=redrive-failed");
    expect(location).not.toContain("INTERNAL_SECRET");
    expect(location).not.toContain("storage");

    const page = await configured.app.request(
      `${redirectUrl.origin}${redirectUrl.pathname}${redirectUrl.search}`,
      {},
      configured.bindings,
    );
    const html = await page.text();
    expect(html).toContain("Failed to redrive delivery job.");
    expect(html).toContain(
      "The operation failed unexpectedly. Check Workers Logs for details.",
    );
    expect(html).not.toContain("storage credentials were rejected");
  });

  test("discards an EventHub cursor when switching instances", async () => {
    const { app, bindings } = setup();
    const response = await app.request(
      "http://localhost/?instance=alpha&cursor=opaque",
      {},
      bindings,
    );
    const html = await response.text();

    expect(html).toContain('<form method="get" action="/">');
    expect(html).not.toContain('name="cursor"');
  });

  test("deletes the selected instance from the Registry", async () => {
    const { app, bindings, registryDelete } = setup({
      active: [],
      stale: [instance("tenant:acme", "stale")],
    });
    const page = await app.request(
      "http://localhost/?instance=tenant%3Aacme&showStale=1",
      {},
      bindings,
    );
    const html = await page.text();

    expect(html).toContain(
      'action="/api/instances/delete?instance=tenant%3Aacme&amp;showStale=1"',
    );
    expect(html).toContain("Delete instance");

    const response = await app.request(
      "http://localhost/api/instances/delete?instance=tenant%3Aacme",
      { method: "POST" },
      bindings,
    );

    expect(registryDelete).toHaveBeenCalledWith("tenant:acme");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });

  test("does not allow an active instance to be deleted", async () => {
    const { app, bindings, registryDelete } = setup({
      active: [instance("active")],
    });
    const page = await app.request(
      "http://localhost/?instance=active",
      {},
      bindings,
    );

    expect(await page.text()).not.toContain("Delete instance");

    const response = await app.request(
      "http://localhost/api/instances/delete?instance=active",
      { method: "POST" },
      bindings,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Only stale instances can be deleted",
    });
    expect(registryDelete).not.toHaveBeenCalled();
  });

  test("does not delete an unknown instance", async () => {
    const { app, bindings, registryDelete } = setup();
    const response = await app.request(
      "http://localhost/api/instances/delete?instance=unknown",
      { method: "POST" },
      bindings,
    );

    expect(response.status).toBe(404);
    expect(registryDelete).not.toHaveBeenCalled();
  });

  test("does not resolve a deleted instance", async () => {
    const configured = setup();
    configured.registryGet.mockResolvedValue({
      ok: true,
      value: instance("deleted", "deleted"),
    });

    const response = await configured.app.request(
      "http://localhost/api/events/latest?instance=deleted",
      {},
      configured.bindings,
    );

    expect(response.status).toBe(404);
    expect(configured.eventHubGetByName).not.toHaveBeenCalled();
  });

  test("requires an explicit instance when deleting", async () => {
    const { app, bindings, registryDelete } = setup();
    const response = await app.request(
      "http://localhost/api/instances/delete",
      { method: "POST" },
      bindings,
    );

    expect(response.status).toBe(404);
    expect(registryDelete).not.toHaveBeenCalled();
  });

  test("reports Registry unavailability when instance lookup fails", async () => {
    const configured = setup();
    configured.registryGet.mockRejectedValue(new Error("registry offline"));

    const response = await configured.app.request(
      "http://localhost/api/instances/delete?instance=old",
      { method: "POST" },
      configured.bindings,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({
      error: "EventHub Registry unavailable",
    });
    expect(configured.registryDelete).not.toHaveBeenCalled();
  });

  test("reports Registry unavailability when deletion fails", async () => {
    const configured = setup({
      active: [],
      stale: [instance("old", "stale")],
    });
    configured.registryDelete.mockRejectedValue(new Error("registry offline"));

    const response = await configured.app.request(
      "http://localhost/api/instances/delete?instance=old",
      { method: "POST" },
      configured.bindings,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({
      error: "EventHub Registry unavailable",
    });
  });
});

describe("latest event polling", () => {
  test("does not list Registry instances at the exact API mount point", async () => {
    const configured = setup();

    const response = await configured.app.request(
      "http://localhost/api",
      {},
      configured.bindings,
    );

    expect(response.status).toBe(404);
    expect(configured.registryGet).not.toHaveBeenCalled();
    expect(configured.registryList).not.toHaveBeenCalled();
  });

  test("returns the creation time of an event without delivery jobs", async () => {
    const configured = setup();
    configured.hubs.get("alpha")?.list.mockResolvedValue({
      ok: true,
      value: {
        payloads: [
          {
            payloadId: "payload-no-route",
            createdAt: "2026-09-15T01:02:03.000Z",
            payload: { kind: "other" },
            deliveryJobs: [],
          },
        ],
      },
    });

    const response = await configured.app.request(
      "http://localhost/api/events/latest?instance=alpha",
      {},
      configured.bindings,
    );

    expect(await response.json()).toStrictEqual({
      lastUpdatedAt: Date.parse("2026-09-15T01:02:03.000Z"),
    });
    expect(configured.registryGet).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(configured.registryList).not.toHaveBeenCalled();
  });
});
