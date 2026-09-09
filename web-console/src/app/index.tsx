import { vValidator } from "@hono/valibot-validator";
import { jsxRenderer } from "hono/jsx-renderer";
import * as v from "valibot";

import type {
  EventHub,
  EventHubInstance,
  EventHubRegistry,
  ListResult,
} from "cf-eventhub";
import { Button } from "../components/Button";
import { Event } from "../components/Event";
import { SunMedium } from "../components/Icon";
import { Pagination } from "../components/Pagination";
import { Textarea } from "../components/Textarea";
import { getEventsLastUpdatedAt, normalizeEvents } from "../eventhub";
import type { DateTime } from "../factory";
import { factory, listAllInstances } from "../factory";
import { styles } from "./styles";

const maxPayloadRows = 10;

const pageScript = (
  refreshIntervalSeconds: number,
  lastUpdatedAt: number,
  hasOngoingDelivery: boolean,
  pollUrl: string,
  reloadUrl: string,
) => `
(() => {
  const createModal = document.getElementById("create-event-modal");
  const deliveryDetailModal = document.getElementById("deliveryjob-detail-modal");
  const deliveryDetailFrame = document.getElementById("deliveryjob-detail-frame");
  const notification = document.getElementById("new-event-notification");
  const dismissNotification = document.getElementById("dismiss-notification");

  const closeClosestDialog = (target) => {
    const dialog = target.closest("dialog");
    if (dialog && dialog.open) {
      dialog.close();
    }
  };

  document.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const openCreateModal = target.closest("[data-open-create-modal]");
    if (openCreateModal && createModal) {
      createModal.showModal();
      return;
    }

    const closeDialog = target.closest("[data-close-dialog]");
    if (closeDialog) {
      closeClosestDialog(closeDialog);
      return;
    }

    const copyButton = target.closest("[data-copy-payload]");
    if (copyButton && copyButton instanceof HTMLElement) {
      const text = copyButton.dataset.copyPayload;
      if (text && "clipboard" in navigator) {
        await navigator.clipboard.writeText(text);
      }
      return;
    }

    const detailButton = target.closest("[data-open-deliveryjob-detail]");
    if (
      detailButton &&
      detailButton instanceof HTMLElement &&
      deliveryDetailModal &&
      deliveryDetailFrame
    ) {
      const id = detailButton.dataset.openDeliveryjobDetail;
      if (!id) return;
      const template = document.getElementById(\`deliveryjob-detail-\${id}\`);
      if (!(template instanceof HTMLTemplateElement)) return;
      deliveryDetailFrame.innerHTML = template.innerHTML;
      deliveryDetailModal.showModal();
      return;
    }
  });

  document.addEventListener("submit", (event) => {
    const target = event.target instanceof HTMLFormElement ? event.target : null;
    if (!target) return;
    const confirmMessage = target.querySelector("[data-confirm]")?.getAttribute("data-confirm");
    if (confirmMessage && !window.confirm(confirmMessage)) {
      event.preventDefault();
    }
  });

  if (dismissNotification && notification) {
    dismissNotification.addEventListener("click", () => {
      notification.style.display = "none";
      notification.dataset.dismissed = "true";
    });
  }

  const checkLatestEvent = async () => {
    if (!notification || notification.dataset.dismissed === "true") return;
    const res = await fetch(${JSON.stringify(pollUrl)}, { credentials: "same-origin" });
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.lastUpdatedAt !== "number") return;
    if (data.lastUpdatedAt > ${lastUpdatedAt}) {
      notification.style.display = "flex";
    }
  };

  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void checkLatestEvent();
      ${hasOngoingDelivery ? `window.location.href = ${JSON.stringify(reloadUrl)};` : ""}
    }
  }, ${refreshIntervalSeconds * 1000});
})();
`;

const renderer = (environment?: string) =>
  jsxRenderer(({ children }, _options) => {
    const title = environment
      ? `${environment.toUpperCase()}: eventhub: console`
      : "eventhub: console";
    return (
      <html lang="en">
        <head>
          <title>{title}</title>
          <style
            // biome-ignore  lint/security/noDangerouslySetInnerHtml: generated stylesheet
            dangerouslySetInnerHTML={{ __html: styles }}
          />
        </head>
        <body>{children}</body>
      </html>
    );
  });

const defaultPlaceholder = `{
    eventName: "My Event",
    data: {
        message: "Hello, world!"
    }
}`;

const ConsoleState = ({ title, detail }: { title: string; detail: string }) => (
  <div class="my-16 py-32 px-6 grid place-items-center text-center">
    <div>
      <div class="text-2xl font-bold">{title}</div>
      <p class="mt-3 max-w-2xl text-gray-600">{detail}</p>
    </div>
  </div>
);

const ConsoleHeader = ({
  environment,
  color,
  instances,
  selectedName,
  showStale,
  buildUrl,
  showCreate = false,
}: {
  environment?: string;
  color?: `#${string}`;
  instances: EventHubInstance[];
  selectedName?: string;
  showStale: boolean;
  buildUrl: (
    path: string,
    values?: Record<string, string | boolean | null | undefined>,
  ) => string;
  showCreate?: boolean;
}) => (
  <>
    <div
      class="h-2 bg-blue-300"
      style={color ? `background-color: ${color};` : undefined}
    />
    <div class="md:mx-16 mx-6 my-12 flex justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-3xl font-semibold pt-1">
          eventhub:
          <span class="ml-2 text-gray-500">console</span>
          {environment && <span class="ml-2 uppercase">[{environment}]</span>}
        </h1>
        <div class="mt-4 flex items-center gap-3 flex-wrap">
          <form method="get" action="/">
            <label for="eventhub-instance" class="mr-2 font-medium">
              Instance
            </label>
            <select
              id="eventhub-instance"
              name="instance"
              class="rounded-md border border-gray-300 bg-white px-3 py-2"
              onchange="this.form.submit()"
            >
              {!selectedName && <option value="">Select an instance</option>}
              {instances.map((instance) => (
                <option
                  key={instance.name}
                  value={instance.name}
                  selected={instance.name === selectedName}
                >
                  {instance.name}
                  {instance.status === "stale"
                    ? ` (stale; last seen ${instance.lastSeenAt})`
                    : ""}
                </option>
              ))}
            </select>
            {showStale && <input type="hidden" name="showStale" value="1" />}
          </form>
          <a
            class="text-sm underline text-gray-600 hover:text-black"
            href={
              showStale
                ? buildUrl("/", {
                    showStale: null,
                    instance:
                      instances.find((item) => item.name === selectedName)
                        ?.status === "stale"
                        ? null
                        : selectedName,
                  })
                : buildUrl("/", { showStale: true })
            }
          >
            {showStale ? "Hide stale" : "Show stale"}
          </a>
        </div>
      </div>
      {showCreate && (
        <Button type="button" data-open-create-modal>
          <div class="flex gap-2 py-1 text-nowrap">
            <SunMedium title="Create event" />
            Create event
          </div>
        </Button>
      )}
    </div>
  </>
);

/**
 * Creates a handler for the web console.
 * @returns Hono handler.
 */
export const createHandler = ({
  pageSize = 5,
  dateFormatter = new Intl.DateTimeFormat(),
  refreshIntervalSeconds = 5,
  color,
  environment,
  eventHub = { binding: "EVENT_HUB" },
  registry = { binding: "EVENT_HUB_REGISTRY" },
  eventTitle,
  createEventPlaceholder,
}: {
  pageSize?: number;
  dateFormatter?: Intl.DateTimeFormat;
  refreshIntervalSeconds?: number;
  color?: `#${string}`;
  environment?: string;
  eventHub?: {
    binding?: string;
  };
  registry?: {
    binding?: string;
  };
  eventTitle?: (e: ReturnType<typeof normalizeEvents>[number]) => string;
  createEventPlaceholder?: string;
}) =>
  factory
    .createApp()
    .use(async (c, next) => {
      c.set("dateFormatter", (d: DateTime) => {
        return dateFormatter.format(typeof d === "string" ? new Date(d) : d);
      });
      c.set("dateRangeFormatter", (d1: DateTime, d2: DateTime) => {
        return dateFormatter.formatRange(
          typeof d1 === "string" ? new Date(d1) : d1,
          typeof d2 === "string" ? new Date(d2) : d2,
        );
      });
      const eventHubBindingName = eventHub.binding ?? "EVENT_HUB";
      const binding = c.env[
        eventHubBindingName
      ] as DurableObjectNamespace<EventHub>;
      if (!binding) {
        throw new Error(`EventHub binding not found: ${eventHubBindingName}`);
      }

      const registryBindingName = registry.binding ?? "EVENT_HUB_REGISTRY";
      const registryBinding = c.env[
        registryBindingName
      ] as DurableObjectNamespace<EventHubRegistry>;
      if (!registryBinding) {
        throw new Error(
          `EventHub Registry binding not found: ${registryBindingName}`,
        );
      }

      const registryStub = registryBinding.getByName("default");
      const search = new URL(c.req.url).searchParams;
      const requestedInstance = search.get("instance") ?? undefined;
      const showStale = search.get("showStale") === "1";
      let instances: Awaited<ReturnType<typeof listAllInstances>> = [];
      let selectedInstance: (typeof instances)[number] | undefined;
      let registryError: string | undefined;

      try {
        const active = await listAllInstances(registryStub, "active");
        const requestedIsActive = active.some(
          (instance) => instance.name === requestedInstance,
        );
        const stale =
          showStale ||
          active.length === 0 ||
          (requestedInstance && !requestedIsActive)
            ? await listAllInstances(registryStub, "stale")
            : [];
        instances = [...active, ...stale];
        selectedInstance = requestedInstance
          ? instances.find((instance) => instance.name === requestedInstance)
          : active[0];
      } catch (error) {
        registryError = error instanceof Error ? error.message : String(error);
      }

      const buildUrl = (
        path: string,
        values: Record<
          string,
          string | number | boolean | null | undefined
        > = {},
      ): string => {
        const query = new URLSearchParams();
        if (selectedInstance) query.set("instance", selectedInstance.name);
        if (showStale || selectedInstance?.status === "stale") {
          query.set("showStale", "1");
        }
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined || value === null || value === false) {
            query.delete(key);
          } else {
            query.set(key, value === true ? "1" : String(value));
          }
        }
        const encoded = query.toString();
        return encoded ? `${path}?${encoded}` : path;
      };

      c.set("eventHubBinding", binding);
      c.set("registryBinding", registryBinding);
      c.set("registry", registryStub);
      c.set("instances", instances);
      c.set("selectedInstance", selectedInstance);
      c.set("requestedInstance", requestedInstance);
      c.set("showStale", showStale);
      c.set("registryError", registryError);
      c.set("getEventHub", () =>
        selectedInstance ? binding.getByName(selectedInstance.name) : undefined,
      );
      c.set("buildUrl", buildUrl);
      return next();
    })
    .get(
      "/",
      vValidator(
        "query",
        v.fallback(
          v.object({
            cursor: v.nullish(v.string()),
            pageSize: v.nullish(v.number(), pageSize),
            error: v.nullish(v.string()),
          }),
          { cursor: null, pageSize, error: null },
        ),
      ),
      renderer(environment),
      async (c) => {
        const { cursor, error } = c.req.valid("query");
        const max = c.req.valid("query").pageSize;
        const hub = c.var.getEventHub();

        if (c.var.registryError) {
          c.status(503);
          return c.render(
            <ConsoleState
              title="Registry unavailable"
              detail="The EventHub Registry could not be read. EventHub data-plane operations are unaffected. Check the Registry binding and try again."
            />,
          );
        }

        if (!hub) {
          const hasInstances = c.var.instances.length > 0;
          if (c.var.requestedInstance) c.status(404);
          return c.render(
            <div>
              <ConsoleHeader
                environment={environment}
                color={color}
                instances={c.var.instances}
                selectedName={undefined}
                showStale={c.var.showStale}
                buildUrl={c.var.buildUrl}
              />
              <ConsoleState
                title={
                  hasInstances
                    ? "Select an EventHub instance"
                    : "No EventHub instances found"
                }
                detail={
                  hasInstances
                    ? "Choose an available instance above. Stale instances remain usable and are labeled with their last-seen time."
                    : "Configure the EventHub and Registry bindings, then perform the first activity on a named EventHub instance. Registration is asynchronous."
                }
              />
            </div>,
          );
        }

        let listed: ListResult;
        let latest: ListResult;
        try {
          listed = await hub.list({
            max,
            cursor: cursor ?? undefined,
            order: "desc",
          });
          latest = await hub.list({ max: 10, order: "desc" });
        } catch {
          c.status(502);
          return c.render(
            <div>
              <ConsoleHeader
                environment={environment}
                color={color}
                instances={c.var.instances}
                selectedName={c.var.selectedInstance?.name}
                showStale={c.var.showStale}
                buildUrl={c.var.buildUrl}
              />
              <ConsoleState
                title="EventHub instance unavailable"
                detail={`The selected instance (${c.var.selectedInstance?.name}) could not be read. Try again or select another instance.`}
              />
            </div>,
          );
        }
        const events = normalizeEvents(listed);
        const latestEvents = normalizeEvents(latest);
        const hasOngoingDelivery = events.some((event) =>
          event.deliveryJobs.some((job) => job.status === "ongoing"),
        );
        const lastUpdatedAt = getEventsLastUpdatedAt(latestEvents);

        const nextUrl = listed.cursor
          ? c.var.buildUrl("/", {
              cursor: listed.cursor,
              pageSize: max !== pageSize ? max : undefined,
            })
          : undefined;

        const range = (() => {
          const dateRange = events
            .map((event) => event.createdAt)
            .filter((createdAt): createdAt is string => createdAt !== null);
          if (dateRange.length === 0) return undefined;
          if (dateRange.length === 1) return [dateRange[0]] as [string];
          return [dateRange[dateRange.length - 1], dateRange[0]] as [
            string,
            string,
          ];
        })();

        return c.render(
          <div>
            <div
              id="new-event-notification"
              class="fixed inset-x-0 mx-auto top-8 h-0 flex justify-center"
              style="display:none;"
            >
              <div class="z-999 w-fit flex items-center text-white rounded-full bg-black drop-shadow-xl pl-4 pr-2 py-6">
                <div>
                  <SunMedium title="" />
                </div>
                <div class="text-white px-2 py-1">
                  <a
                    class="hover:underline"
                    href={c.var.buildUrl("/")}
                    title="Go to the latest events"
                  >
                    Events or delivery statuses have been updated
                  </a>
                </div>
                <button
                  id="dismiss-notification"
                  class="rounded-full ml-1 px-2 py-1 hover:bg-gray-900 select-none"
                  type="button"
                >
                  dismiss
                </button>
              </div>
            </div>
            <ConsoleHeader
              environment={environment}
              color={color}
              instances={c.var.instances}
              selectedName={c.var.selectedInstance?.name}
              showStale={c.var.showStale}
              buildUrl={c.var.buildUrl}
              showCreate
            />
            <div class="pb-6">
              <dialog
                id="create-event-modal"
                class="outline-1 outline-gray-900/20 rounded-xl backdrop:bg-gray-100/30 backdrop:backdrop-blur-[2px]"
              >
                <div class="m-px p-4 rounded-xl">
                  <h2 class="text-2xl font-semibold">
                    <span class="flex gap-1 items-center">
                      <SunMedium title="" /> Create event
                    </span>
                  </h2>
                  <form method="post" action={c.var.buildUrl("/api/events")}>
                    <div class="my-6">
                      <div class="mb-1">Enter your payload here:</div>
                      <Textarea
                        name="payload"
                        placeholder={
                          createEventPlaceholder || defaultPlaceholder
                        }
                        cols={60}
                        rows={maxPayloadRows}
                        minlength={1}
                        required
                      />
                    </div>
                    <div class="flex gap-2">
                      <Button
                        type="submit"
                        data-confirm="Are you sure you wish to create new event?"
                      >
                        Create
                      </Button>
                      <Button type="button" data-close-dialog secondary>
                        Cancel
                      </Button>
                    </div>
                  </form>
                </div>
              </dialog>

              <dialog
                id="deliveryjob-detail-modal"
                class="outline-1 outline-gray-900/20 rounded-xl backdrop:bg-gray-100/30 backdrop:backdrop-blur-[2px]"
              >
                <div
                  id="deliveryjob-detail-frame"
                  class="m-px p-4 rounded-xl"
                />
              </dialog>

              <div class="mx-16 mt-2 mb-4">
                {error === "invalid-payload" && (
                  <div class="rounded-md bg-red-100 text-red-800 px-4 py-2">
                    Invalid JSON payload. Please enter a valid JSON object.
                  </div>
                )}
                {error === "delivery-not-found" && (
                  <div class="rounded-md bg-red-100 text-red-800 px-4 py-2">
                    Delivery job not found. It may have already been archived.
                  </div>
                )}
              </div>

              <div class="flex flex-col justify-center gap-12 overflow-hidden pt-1 pb-6">
                {events.length > 0 ? (
                  events.map((event) => (
                    <Event
                      key={event.id}
                      event={event}
                      formatDate={c.var.dateFormatter}
                      eventTitle={eventTitle}
                      buildUrl={c.var.buildUrl}
                    />
                  ))
                ) : (
                  <div class="my-16 py-32 grid place-items-center">
                    <div class="text-2xl font-bold">no events.</div>
                  </div>
                )}
                <Pagination
                  topUrl={cursor ? c.var.buildUrl("/") : undefined}
                  nextUrl={nextUrl}
                  range={range}
                  formatDateRange={c.var.dateRangeFormatter}
                />
              </div>
            </div>
            <script
              // biome-ignore  lint/security/noDangerouslySetInnerHtml: safe
              dangerouslySetInnerHTML={{
                __html: pageScript(
                  refreshIntervalSeconds,
                  lastUpdatedAt,
                  hasOngoingDelivery,
                  c.var.buildUrl("/api/events/latest"),
                  c.var.buildUrl("/"),
                ),
              }}
            />
          </div>,
        );
      },
    );
