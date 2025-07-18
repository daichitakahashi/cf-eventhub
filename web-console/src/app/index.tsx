import { vValidator } from "@hono/valibot-validator";
import { clsx } from "clsx";
import { Style } from "hono/css";
import { jsxRenderer } from "hono/jsx-renderer";
import "typed-htmx";
import * as v from "valibot";

import { Button } from "../components/Button";
import { CreateEvent } from "../components/CreateEvent";
import { DispatchDetails, Event, EventDispatches } from "../components/Event";
import { SunMedium } from "../components/Icon";
import { Modal, useSharedModal } from "../components/Modal";
import { useNotification } from "../components/Notification";
import { Pagination } from "../components/Pagination";
import type { EventWithDispatches } from "../components/types";
import { type DateTime, factory } from "../factory";

declare module "hono/jsx" {
  // biome-ignore lint/style/noNamespace: <explanation>
  namespace JSX {
    interface HTMLAttributes extends HtmxAttributes {}
  }
}

const renderer = (environment?: string) =>
  jsxRenderer(({ children }, _options) => {
    const title = environment
      ? `${environment.toUpperCase()}: cf-eventhub: web console`
      : "cf-eventhub: web console";
    return (
      <html lang="en">
        <head>
          <title>{title}</title>
          <Style />
          <script src="https://cdn.tailwindcss.com" />
          <script
            src="https://unpkg.com/htmx.org@2.0.3/dist/htmx.min.js"
            integrity="sha384-0895/pl2MU10Hqc6jd4RvrthNlDiE9U1tWmX7WRESftEDRosgxNsQG/Ze9YMRzHq"
            crossorigin="anonymous"
          />
          <script
            src="https://unpkg.com/hyperscript.org@0.9.13/dist/_hyperscript.min.js"
            integrity="sha384-5yQ5JTatiFEgeiEB4mfkRI3oTGtaNpbJGdcciZ4IEYFpLGt8yDsGAd7tKiMwnX9b"
            crossorigin="anonymous"
          />
        </head>
        <body>{children}</body>
      </html>
    );
  });

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
  eventTitle,
}: {
  /** Number of events that displayed in each page. */
  pageSize?: number;
  /** Date formatter for displaying date and time. */
  dateFormatter?: Intl.DateTimeFormat;
  /** Interval seconds of auto-refreshing dispatch list for each event. */
  refreshIntervalSeconds?: number;
  /** Custom color. */
  color?: `#${string}`;
  /** Environment display. */
  environment?: string;
  /** Custom event title function. */
  eventTitle?: (e: EventWithDispatches) => string;
}) =>
  factory
    .createApp()
    .use((c, next) => {
      c.set("dateFormatter", (d: DateTime) => {
        return dateFormatter.format(d as unknown as Date);
      });
      c.set("dateRangeFormatter", (d1: DateTime, d2: DateTime) => {
        return dateFormatter.formatRange(
          d1 as unknown as Date,
          d2 as unknown as Date,
        );
      });
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
          }),
          { cursor: null, pageSize },
        ),
      ),
      renderer(environment),
      async (c) => {
        const currentCursor = c.req.valid("query").cursor || undefined;
        const maxItems = c.req.valid("query").pageSize;

        const list = await c.env.EVENTHUB.listEvents({
          maxItems,
          continuationToken: currentCursor,
          orderBy: "CREATED_AT_DESC",
        });
        let lastUpdatedAt: number;
        if (!currentCursor) {
          // first page
          lastUpdatedAt = list.list.at(0)?.createdAt.getTime() || Date.now();
        } else {
          // other page
          const list = await c.env.EVENTHUB.listEvents({
            maxItems: 1,
            orderBy: "CREATED_AT_DESC",
          });
          lastUpdatedAt = list.list.at(0)?.createdAt.getTime() || Date.now();
        }

        const events = list.list;
        const nextUrl = list.continuationToken
          ? (() => {
              const query = new URLSearchParams();
              query.set("cursor", list.continuationToken);
              if (maxItems !== pageSize) {
                query.set("pageSize", maxItems.toString());
              }
              return `/?${query.toString()}`;
            })()
          : undefined;

        const SharedModal = useSharedModal();

        const [Notification, openNotification] = useNotification({
          id: "notification",
          onDismiss: "send dismiss to #notification-checker",
        });

        return c.render(
          <div>
            <div
              id="notification-checker"
              _={`
                set :checking to true
                on load
                  repeat while :checking
                    fetch '/api/events/latest' as json
                    log the result
                    if the result.lastUpdatedAt > ${lastUpdatedAt}
                      log 'new event created'
                      ${openNotification}
                    end
                    wait 5s
                  end
                end
                on dismiss
                  set :checking to false
                  log 'notification dismissed, stop checker'
                end
              `}
            >
              <Notification icon={<SunMedium title="event" />}>
                <a
                  class="hover:underline"
                  href="/"
                  noopener
                  noreferrer
                  title="Go to the latest events"
                >
                  New event created
                </a>
              </Notification>
            </div>
            <div class={clsx("h-2", color ? `bg-[${color}]` : "bg-blue-300")} />
            <div class="pb-6">
              <div class="mx-16 my-12 flex justify-between">
                <h1 class="text-3xl font-semibold pt-1">
                  cf-eventhub:
                  <span class="ml-2 text-gray-500">web console</span>
                  {environment && (
                    <span class="ml-2 uppercase">[{environment}]</span>
                  )}
                </h1>
                <Modal
                  target={(_) => (
                    <Button type="button" _={_}>
                      <div class="flex gap-2 py-1">
                        <SunMedium title="Create event" />
                        Create event
                      </div>
                    </Button>
                  )}
                >
                  {(_) => <CreateEvent closeModal={_} />}
                </Modal>
              </div>
              <SharedModal />
              <div class="flex flex-col justify-center gap-12 overflow-hidden pt-1 pb-6">
                {events.length > 0 ? (
                  events.map((e) => (
                    <Event
                      key={e.id}
                      event={e}
                      formatDate={c.var.dateFormatter}
                      refreshIntervalSeconds={refreshIntervalSeconds}
                      eventTitle={eventTitle}
                    />
                  ))
                ) : (
                  <div class="my-16 py-32 grid place-items-center">
                    <div class="text-2xl font-bold">no events.</div>
                  </div>
                )}
                <Pagination
                  topUrl={currentCursor ? "/" : undefined}
                  nextUrl={nextUrl}
                  range={
                    events.length === 0
                      ? undefined
                      : events.length === 1
                        ? ([events[0].createdAt] as unknown as [Date])
                        : ([
                            events[events.length - 1].createdAt,
                            events[0].createdAt,
                          ] as unknown as [Date, Date])
                  }
                  formatDateRange={c.var.dateRangeFormatter}
                />
              </div>
            </div>
          </div>,
        );
      },
    )
    .get(
      "/components/event/:id/dispatches",
      vValidator(
        "param",
        v.object({
          id: v.pipe(v.string(), v.minLength(1)),
        }),
      ),
      async (c) => {
        const event = await c.env.EVENTHUB.getEvent(c.req.valid("param").id);
        if (!event) {
          return c.newResponse(null, { status: 404 });
        }

        return c.render(
          <EventDispatches
            eventId={event.id}
            dispatches={event.dispatches}
            formatDate={c.var.dateFormatter}
            refreshIntervalSeconds={refreshIntervalSeconds}
          />,
        );
      },
    )
    .get(
      "/components/dispatch-detail-modal/:id",
      vValidator(
        "param",
        v.object({
          id: v.pipe(v.string(), v.minLength(1)),
        }),
      ),
      async (c) => {
        const dispatch = await c.env.EVENTHUB.getDispatch(
          c.req.valid("param").id,
        );
        if (!dispatch) {
          return c.newResponse(null, { status: 404 });
        }
        return c.render(
          <DispatchDetails
            dispatch={dispatch}
            formatDate={c.var.dateFormatter}
          />,
        );
      },
    );
