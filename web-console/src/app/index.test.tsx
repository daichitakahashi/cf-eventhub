import type {
  EventHub,
  EventHubInstance,
  EventHubRegistry,
  ListResult,
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
        list: vi.fn(async () => emptyList()),
        publish: vi.fn(async () => undefined),
        redrive: vi.fn(async () => true),
      },
    ]),
  );
  const eventHubGetByName = vi.fn((name: string) => hubs.get(name));
  const registryList = vi.fn(
    async ({ status }: { status?: EventHubInstance["status"] } = {}) => ({
      instances:
        status === "stale" ? stale : status === "deleted" ? [] : active,
    }),
  );
  const bindings = {
    EVENT_HUB: {
      getByName: eventHubGetByName,
    } as unknown as DurableObjectNamespace<EventHub>,
    EVENT_HUB_REGISTRY: {
      getByName: vi.fn(() => ({ list: registryList })),
    } as unknown as DurableObjectNamespace<EventHubRegistry>,
  };
  return {
    app: createWebConsole({}),
    bindings,
    hubs,
    eventHubGetByName,
    registryList,
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
        payloads: [
          {
            payload: { hello: "world" },
            deliveryJobs: [
              {
                id: "job-1",
                payloadId: "payload-1",
                destination: "QUEUE",
                createdAt: "2026-09-01T00:00:00.000Z",
                retryCount: 0,
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
      })
      .mockResolvedValueOnce(emptyList());
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
    const { app, bindings, hubs } = setup();
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
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?instance=beta");
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
});
