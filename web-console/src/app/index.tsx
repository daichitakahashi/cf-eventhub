import { vValidator } from "@hono/valibot-validator";
import {
  EVENT_HUB_REGISTRY_NAME,
  type EventHub,
  type EventHubInstance,
  type EventHubRegistry,
  type ListResult,
  type ResultError,
} from "cf-eventhub";
import { jsxRenderer } from "hono/jsx-renderer";
import * as v from "valibot";
import { Button } from "../components/Button";
import { Event } from "../components/Event";
import { SunMedium } from "../components/Icon";
import { Pagination } from "../components/Pagination";
import { Textarea } from "../components/Textarea";
import { getEventsLastUpdatedAt, normalizeEvents } from "../eventhub";
import type { DateTime } from "../factory";
import { factory } from "../factory";
import {
  eventHubErrorMessages,
  operationErrorTitles,
  unexpectedOperationErrorMessage,
} from "../operation-error";
import { styles } from "./styles";

const maxPayloadRows = 10;
const maxQueueMessageBytes = 128_000;

const instancePickerScript = `
(() => {
  const dialog = document.getElementById("instance-picker-modal");
  const opener = document.getElementById("open-instance-picker");
  const search = document.getElementById("instance-picker-search");
  const showStale = document.getElementById("instance-picker-show-stale");
  if (!(dialog instanceof HTMLDialogElement) ||
      !(opener instanceof HTMLButtonElement) ||
      !(search instanceof HTMLInputElement) ||
      !(showStale instanceof HTMLInputElement)) return;

  let generation = 0;
  let timer;
  const load = async (status, cursor, append, currentGeneration) => {
    const list = document.getElementById("instance-picker-" + status);
    const more = document.getElementById("instance-picker-more-" + status);
    if (!list || !more) return;
    if (!append) list.replaceChildren();
    more.hidden = true;
    const params = new URLSearchParams({ status, search: search.value });
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await fetch("/api/instances/search?" + params, {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Unable to load instances");
      const page = await response.json();
      if (currentGeneration !== generation) return;
      if (!append && page.instances.length === 0) {
        const empty = document.createElement("li");
        empty.className = "p-4 text-gray-500";
        empty.textContent = "No matching instances";
        list.append(empty);
      }
      for (const instance of page.instances) {
        const row = document.createElement("li");
        const link = document.createElement("a");
        const url = new URL("/", window.location.origin);
        url.searchParams.set("instance", instance.name);
        link.href = url.pathname + url.search;
        link.className = "block p-3 hover:bg-gray-100 rounded-md break-all";
        const name = document.createElement("span");
        name.className = "font-medium";
        name.textContent = instance.name;
        link.append(name);
        if (instance.status === "stale") {
          const detail = document.createElement("span");
          detail.className = "block text-sm text-gray-600";
          detail.textContent = "Last seen " + instance.lastSeenAt;
          link.append(detail);
        }
        link.addEventListener("click", () => dialog.close());
        row.append(link);
        list.append(row);
      }
      more.hidden = !page.cursor;
      more.dataset.cursor = page.cursor || "";
    } catch {
      if (currentGeneration !== generation) return;
      const error = document.createElement("li");
      error.className = "p-4 text-red-700";
      error.textContent = "Unable to load instances. Try searching again.";
      list.append(error);
    }
  };
  const refresh = () => {
    generation += 1;
    const currentGeneration = generation;
    void load("active", undefined, false, currentGeneration);
    const staleList = document.getElementById("instance-picker-stale-section");
    if (staleList) staleList.hidden = !showStale.checked;
    if (showStale.checked) void load("stale", undefined, false, currentGeneration);
  };
  opener.addEventListener("click", () => {
    showStale.checked = false;
    search.value = "";
    dialog.showModal();
    search.focus();
    refresh();
  });
  dialog.querySelector("[data-close-instance-picker]")?.addEventListener("click", () => dialog.close());
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
  });
  showStale.addEventListener("change", refresh);
  for (const status of ["active", "stale"]) {
    document.getElementById("instance-picker-more-" + status)?.addEventListener("click", (event) => {
      const cursor = event.currentTarget.dataset.cursor;
      if (cursor) void load(status, cursor, true, generation);
    });
  }
})();
`;

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
  const createPayload = document.getElementById("create-event-payload");
  const queueSizeWarning = document.getElementById("queue-size-warning");
  const operationError = document.getElementById("operation-error");
  const operationErrorTitle = document.getElementById("operation-error-title");
  const operationErrorCode = document.getElementById("operation-error-code");
  const operationErrorCodeValue = document.getElementById("operation-error-code-value");
  const operationErrorMessage = document.getElementById("operation-error-message");
  const textEncoder = new TextEncoder();

  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const operationErrorType = fragment.get("error");
  const operationErrorTitles = ${JSON.stringify(operationErrorTitles)};
  const eventHubErrorMessages = ${JSON.stringify(eventHubErrorMessages)};
  if (
    operationError &&
    operationErrorTitle &&
    operationErrorCode &&
    operationErrorCodeValue &&
    operationErrorMessage &&
    Object.prototype.hasOwnProperty.call(operationErrorTitles, operationErrorType)
  ) {
    const code = fragment.get("code");
    operationErrorTitle.textContent = operationErrorTitles[operationErrorType];
    if (code && Object.prototype.hasOwnProperty.call(eventHubErrorMessages, code)) {
      operationErrorCodeValue.textContent = code;
      operationErrorCode.hidden = false;
      operationErrorMessage.textContent = eventHubErrorMessages[code];
    } else {
      operationErrorMessage.textContent = ${JSON.stringify(unexpectedOperationErrorMessage)};
    }
    operationError.hidden = false;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  const updateQueueSizeWarning = () => {
    if (!(createPayload instanceof HTMLTextAreaElement) || !queueSizeWarning) return;
    try {
      const payload = JSON.parse(createPayload.value);
      const bytes = textEncoder.encode(JSON.stringify(payload)).byteLength;
      queueSizeWarning.hidden = bytes <= ${maxQueueMessageBytes};
    } catch {
      queueSizeWarning.hidden = true;
    }
  };

  if (createPayload) {
    createPayload.addEventListener("input", updateQueueSizeWarning);
    updateQueueSizeWarning();
  }

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
          <style dangerouslySetInnerHTML={{ __html: styles }} />
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
  selectedName,
  selectedStatus,
  buildUrl,
  showCreate = false,
}: {
  environment?: string;
  color?: `#${string}`;
  selectedName?: string;
  selectedStatus?: EventHubInstance["status"];
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
        <div class="mt-2 flex items-center gap-3 flex-wrap">
          <span class="font-medium">Instance</span>
          <button
            id="open-instance-picker"
            type="button"
            class="rounded-md border border-gray-300 bg-white px-3 py-2 cursor-pointer hover:bg-gray-100 break-all"
            aria-haspopup="dialog"
            aria-controls="instance-picker-modal"
            title="Select an instance"
          >
            {selectedName ?? "Select an instance"}
            {selectedStatus === "stale" ? " (stale)" : ""}
          </button>
          {selectedName && selectedStatus === "stale" && (
            <form method="post" action={buildUrl("/api/instances/delete")}>
              <button
                type="submit"
                class="text-sm underline text-red-700 hover:text-red-900 cursor-pointer"
                title="Delete instance from the Registry"
                data-confirm={`Delete ${selectedName} from the Registry? EventHub data will not be deleted.`}
              >
                Delete instance
              </button>
            </form>
          )}
        </div>
      </div>
      {showCreate && (
        <div class="flex items-center">
          <Button
            type="button"
            data-open-create-modal
            title="Create event to be published"
          >
            <div class="flex gap-2 py-1 text-nowrap">
              <SunMedium title="Create event" />
              Create event
            </div>
          </Button>
        </div>
      )}
    </div>
    <dialog
      id="instance-picker-modal"
      aria-labelledby="instance-picker-title"
      class="w-full max-w-2xl outline-1 outline-gray-900/20 rounded-xl backdrop:bg-gray-100/30 backdrop:backdrop-blur-[2px]"
    >
      <div class="p-4">
        <div class="flex justify-between items-center gap-4">
          <h2 id="instance-picker-title" class="text-2xl font-semibold">
            Select an instance
          </h2>
          <Button
            type="button"
            data-close-instance-picker
            title="Close instance picker"
            secondary
          >
            Close
          </Button>
        </div>
        <label for="instance-picker-search" class="block mt-4 font-medium">
          Search by name
        </label>
        <input
          id="instance-picker-search"
          type="search"
          maxlength={200}
          class="
            flex min-h-10 w-full rounded-md border border-input mt-1 px-3 py-2
            ring-offset-background placeholder:text-muted-foreground
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
            focus-visible:ring-offset-2 disabled:cursor-not-allowed
            disabled:opacity-50 md:text-sm
          "
          autocomplete="off"
        />
        <label class="flex items-center gap-1 mt-2 mb-4 text-sm cursor-pointer">
          <input id="instance-picker-show-stale" type="checkbox" />
          Show stale
        </label>
        <div class="overflow-auto max-h-75">
          <section aria-label="Active instances">
            <h3 class="font-semibold">Active instances</h3>
            <ul id="instance-picker-active" />
            <button
              id="instance-picker-more-active"
              type="button"
              class="underline cursor-pointer"
              title="Load more active instances"
              hidden
            >
              Load more
            </button>
          </section>
          <section
            id="instance-picker-stale-section"
            aria-label="Stale instances"
            hidden
          >
            <h3 class="font-semibold mt-4">Stale instances</h3>
            <ul id="instance-picker-stale" />
            <button
              id="instance-picker-more-stale"
              type="button"
              class="underline cursor-pointer"
              title="Load more stale instances"
              hidden
            >
              Load more
            </button>
          </section>
        </div>
      </div>
    </dialog>
    <script dangerouslySetInnerHTML={{ __html: instancePickerScript }} />
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

      const registryStub = registryBinding.getByName(EVENT_HUB_REGISTRY_NAME);
      const url = new URL(c.req.url);
      const search = url.searchParams;
      const requestedInstance = search.get("instance") ?? undefined;
      const isApiRequest =
        url.pathname === "/api" || url.pathname.startsWith("/api/");
      let hasInstances = false;
      let selectedInstance: EventHubInstance | undefined;
      let registryError: ResultError["error"] | { message: string } | undefined;

      try {
        if (isApiRequest) {
          const requestedResult = requestedInstance
            ? await registryStub.get(requestedInstance)
            : null;
          if (requestedResult && !requestedResult.ok) {
            registryError = requestedResult.error;
          } else {
            const requested = requestedResult?.value ?? null;
            selectedInstance =
              requested?.status === "active" || requested?.status === "stale"
                ? requested
                : undefined;
          }
        } else {
          const activeResult = await registryStub.list({
            status: "active",
            max: 1,
          });
          if (!activeResult.ok) {
            registryError = activeResult.error;
          } else {
            const firstActive = activeResult.value.instances[0];
            hasInstances = Boolean(firstActive);
            if (requestedInstance) {
              const requestedResult = await registryStub.get(requestedInstance);
              if (!requestedResult.ok) {
                registryError = requestedResult.error;
              } else if (
                requestedResult.value?.status === "active" ||
                requestedResult.value?.status === "stale"
              ) {
                selectedInstance = requestedResult.value;
                hasInstances = true;
              }
            } else {
              selectedInstance = firstActive;
            }
            if (!hasInstances && !registryError) {
              const staleResult = await registryStub.list({
                status: "stale",
                max: 1,
              });
              if (!staleResult.ok) {
                registryError = staleResult.error;
              } else {
                hasInstances = staleResult.value.instances.length > 0;
              }
            }
          }
        }
      } catch (error) {
        registryError = {
          message: error instanceof Error ? error.message : String(error),
        };
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
      c.set("hasInstances", hasInstances);
      c.set("selectedInstance", selectedInstance);
      c.set("requestedInstance", requestedInstance);
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
          {
            cursor: null,
            pageSize,
            error: null,
          },
        ),
      ),
      renderer(environment),
      async (c) => {
        const { cursor, error } = c.req.valid("query");
        const max = c.req.valid("query").pageSize;
        const hub = c.var.getEventHub();

        if (c.var.registryError) {
          c.status(503);
          const code =
            "code" in c.var.registryError
              ? c.var.registryError.code
              : undefined;
          return c.render(
            <ConsoleState
              title="Registry unavailable"
              detail={
                code
                  ? `${eventHubErrorMessages[code]} Error code: ${code}.`
                  : "The EventHub Registry could not be read. EventHub data-plane operations are unaffected. Check the Registry binding and try again."
              }
            />,
          );
        }

        if (!hub) {
          const hasInstances = c.var.hasInstances;
          if (c.var.requestedInstance) c.status(404);
          return c.render(
            <div>
              <ConsoleHeader
                environment={environment}
                color={color}
                selectedName={undefined}
                selectedStatus={undefined}
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

        const renderEventHubFailure = (
          status: 400 | 502,
          title: string,
          detail: string,
        ) => {
          c.status(status);
          return c.render(
            <div>
              <ConsoleHeader
                environment={environment}
                color={color}
                selectedName={c.var.selectedInstance?.name}
                selectedStatus={c.var.selectedInstance?.status}
                buildUrl={c.var.buildUrl}
              />
              <ConsoleState title={title} detail={detail} />
            </div>,
          );
        };

        const renderResultError = (resultError: ResultError["error"]) => {
          const status =
            resultError.code === "INVALID_ARGUMENT" ||
            resultError.code === "INVALID_CURSOR"
              ? 400
              : 502;
          return renderEventHubFailure(
            status,
            "Unable to list events",
            `${eventHubErrorMessages[resultError.code]} Error code: ${resultError.code}.`,
          );
        };

        let listedResult: Awaited<ReturnType<typeof hub.list>>;
        try {
          listedResult = await hub.list({
            max,
            cursor: cursor ?? undefined,
            order: "desc",
          });
        } catch {
          return renderEventHubFailure(
            502,
            "EventHub instance unavailable",
            `The selected instance (${c.var.selectedInstance?.name}) could not be read. Try again or select another instance.`,
          );
        }
        if (!listedResult.ok) return renderResultError(listedResult.error);

        let latestResult: Awaited<ReturnType<typeof hub.list>>;
        try {
          latestResult = await hub.list({ max: 10, order: "desc" });
        } catch {
          return renderEventHubFailure(
            502,
            "EventHub instance unavailable",
            `The selected instance (${c.var.selectedInstance?.name}) could not be read. Try again or select another instance.`,
          );
        }
        if (!latestResult.ok) return renderResultError(latestResult.error);
        const listed: ListResult = listedResult.value;
        const latest: ListResult = latestResult.value;
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
                  title="Dismiss notification"
                >
                  dismiss
                </button>
              </div>
            </div>
            <ConsoleHeader
              environment={environment}
              color={color}
              selectedName={c.var.selectedInstance?.name}
              selectedStatus={c.var.selectedInstance?.status}
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
                        id="create-event-payload"
                        name="payload"
                        aria-describedby="queue-size-warning"
                        placeholder={
                          createEventPlaceholder || defaultPlaceholder
                        }
                        cols={60}
                        rows={maxPayloadRows}
                        minlength={1}
                        required
                      />
                      <output
                        id="queue-size-warning"
                        class="block mt-2 rounded-md bg-yellow-100 text-yellow-800 px-4 py-2"
                        aria-live="polite"
                        hidden
                      >
                        Warning: This payload exceeds the 128 KB Cloudflare
                        Queues message size limit. Publishing may fail if this
                        event is routed to a Queue.
                      </output>
                    </div>
                    <div class="flex gap-2">
                      <Button
                        type="submit"
                        title="Create event"
                        data-confirm="Are you sure you wish to create new event?"
                      >
                        Create
                      </Button>
                      <Button
                        type="button"
                        data-close-dialog
                        title="Cancel creating an event"
                        secondary
                      >
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
                <div
                  id="operation-error"
                  role="alert"
                  class="rounded-md bg-red-100 text-red-800 px-4 py-2"
                  hidden
                >
                  <div id="operation-error-title" class="font-medium" />
                  <div id="operation-error-code" class="mt-1" hidden>
                    Error code: <code id="operation-error-code-value" />
                  </div>
                  <div id="operation-error-message" class="mt-1" />
                </div>
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
