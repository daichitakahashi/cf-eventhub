import { vValidator } from "@hono/valibot-validator";
import { clsx } from "clsx";
import { Style } from "hono/css";
import { jsxRenderer } from "hono/jsx-renderer";
import * as v from "valibot";

import type { EventHub } from "eventhub";
import { Button } from "../components/Button";
import { Event } from "../components/Event";
import { SunMedium } from "../components/Icon";
import { Pagination } from "../components/Pagination";
import { Textarea } from "../components/Textarea";
import { getEventsLastUpdatedAt, normalizeEvents } from "../eventhub";
import type { DateTime } from "../factory";
import { factory } from "../factory";

const maxPayloadRows = 10;

const pageScript = (
  refreshIntervalSeconds: number,
  lastUpdatedAt: number,
  hasOngoingDelivery: boolean,
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
    const res = await fetch("/api/events/latest", { credentials: "same-origin" });
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
      ${hasOngoingDelivery ? "window.location.reload();" : ""}
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
          <Style />
          <script src="https://cdn.tailwindcss.com" />
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
  eventHub = { binding: "EVENT_HUB", instance: "default" },
  eventTitle,
  createEventPlaceholder,
}: {
  pageSize?: number;
  dateFormatter?: Intl.DateTimeFormat;
  refreshIntervalSeconds?: number;
  color?: `#${string}`;
  environment?: string;
  eventHub?: {
    binding: string;
    instance: string;
  };
  eventTitle?: (e: ReturnType<typeof normalizeEvents>[number]) => string;
  createEventPlaceholder?: string;
}) =>
  factory
    .createApp()
    .use((c, next) => {
      c.set("dateFormatter", (d: DateTime) => {
        return dateFormatter.format(typeof d === "string" ? new Date(d) : d);
      });
      c.set("dateRangeFormatter", (d1: DateTime, d2: DateTime) => {
        return dateFormatter.formatRange(
          typeof d1 === "string" ? new Date(d1) : d1,
          typeof d2 === "string" ? new Date(d2) : d2,
        );
      });
      const binding = c.env[
        eventHub.binding
      ] as DurableObjectNamespace<EventHub>;
      if (!binding) throw new Error("EventHub binding not found");

      c.set("eventHubBinding", binding);
      c.set("eventHubInstance", eventHub.instance);
      c.set("getEventHub", () => binding.getByName(eventHub.instance));
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

        const listed = await hub.list({
          max,
          cursor: cursor ?? undefined,
          order: "desc",
        });
        const latest = await hub.list({ max: 10, order: "desc" });
        const events = normalizeEvents(listed);
        const latestEvents = normalizeEvents(latest);
        const hasOngoingDelivery = events.some((event) =>
          event.deliveryJobs.some((job) => job.status === "ongoing"),
        );
        const lastUpdatedAt = getEventsLastUpdatedAt(latestEvents);

        const nextUrl = listed.cursor
          ? (() => {
              const query = new URLSearchParams();
              query.set("cursor", listed.cursor);
              if (max !== pageSize) {
                query.set("pageSize", max.toString());
              }
              return `/?${query.toString()}`;
            })()
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
              <div class="z-[999] w-fit flex items-center text-white rounded-full bg-black drop-shadow-xl pl-4 pr-2 py-6">
                <div>
                  <SunMedium title="" />
                </div>
                <div class="text-white px-2 py-1">
                  <a
                    class="hover:underline"
                    href="/"
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
            <div class={clsx("h-2", color ? `bg-[${color}]` : "bg-blue-300")} />
            <div class="pb-6">
              <div class="mx-16 my-12 flex justify-between">
                <h1 class="text-3xl font-semibold pt-1">
                  eventhub:
                  <span class="ml-2 text-gray-500">console</span>
                  {environment && (
                    <span class="ml-2 uppercase">[{environment}]</span>
                  )}
                </h1>
                <Button type="button" data-open-create-modal>
                  <div class="flex gap-2 py-1">
                    <SunMedium title="Create event" />
                    Create event
                  </div>
                </Button>
              </div>

              <dialog
                id="create-event-modal"
                class="outline outline-1 outline-gray-900/20 rounded-xl backdrop:bg-gray-100/30 backdrop:backdrop-blur-[2px]"
              >
                <div class="m-[1px] p-4 rounded-xl">
                  <h2 class="text-2xl font-semibold">
                    <span class="flex gap-1 items-center">
                      <SunMedium title="" /> Create event
                    </span>
                  </h2>
                  <form method="post" action="/api/events">
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
                class="outline outline-1 outline-gray-900/20 rounded-xl backdrop:bg-gray-100/30 backdrop:backdrop-blur-[2px]"
              >
                <div
                  id="deliveryjob-detail-frame"
                  class="m-[1px] p-4 rounded-xl"
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
                    />
                  ))
                ) : (
                  <div class="my-16 py-32 grid place-items-center">
                    <div class="text-2xl font-bold">no events.</div>
                  </div>
                )}
                <Pagination
                  topUrl={cursor ? "/" : undefined}
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
                ),
              }}
            />
          </div>,
        );
      },
    );
