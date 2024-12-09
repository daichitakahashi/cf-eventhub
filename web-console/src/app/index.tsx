import { vValidator } from "@hono/valibot-validator";
import { Style } from "hono/css";
import { jsxRenderer } from "hono/jsx-renderer";
import "typed-htmx";
import * as v from "valibot";

import { Button } from "../components/Button";
import { CreateEvent } from "../components/CreateEvent";
import { Event } from "../components/Event";
import { SunMedium } from "../components/Icon";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { factory } from "../factory";

declare module "hono/jsx" {
  // biome-ignore lint/style/noNamespace: <explanation>
  namespace JSX {
    interface HTMLAttributes extends HtmxAttributes {}
  }
}

const renderer = jsxRenderer(({ children }, _options) => (
  <html lang="en">
    <head>
      <title>cf-eventhub: web console</title>
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
));

export const createHandler = ({
  dateFormatter,
}: {
  dateFormatter: Intl.DateTimeFormat;
}) =>
  factory
    .createApp()
    .use(renderer)
    .use((c, next) => {
      c.set("dateFormatter", (d: Date | Rpc.Provider<Date>) => {
        return dateFormatter.format(d as unknown as Date);
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
            pageSize: v.nullish(v.number(), 5),
          }),
          { cursor: null, pageSize: 5 },
        ),
      ),
      async (c) => {
        const currentCursor = c.req.valid("query").cursor || undefined;
        const maxItems = c.req.valid("query").pageSize;

        const list = await c.env.EVENTHUB.listEvents({
          maxItems,
          continuationToken: currentCursor,
          orderBy: "CREATED_AT_DESC",
        });

        // const events = [
        //   {
        //     id: crypto.randomUUID(),
        //     createdAt: new Date(),
        //     payload: {
        //       menu: {
        //         id: "file",
        //         value: "File",
        //         popup: {
        //           menuitem: [
        //             { value: "New", onclick: "CreateNewDoc()" },
        //             { value: "Open", onclick: "OpenDoc()" },
        //             { value: "Close", onclick: "CloseDoc()" },
        //           ],
        //         },
        //       },
        //     },
        //     dispatches: [
        //       {
        //         id: crypto.randomUUID(),
        //         eventId: "1",
        //         destination: "STABLE_HANDLER",
        //         status: "ongoing",
        //         executionLog: [{}],
        //         createdAt: new Date(),
        //         maxRetries: 5,
        //         delaySeconds: 1,
        //       },
        //       {
        //         id: crypto.randomUUID(),
        //         eventId: "1",
        //         destination: "FLAKY_HANDLER",
        //         status: "complete",
        //         executionLog: [],
        //         createdAt: new Date(),
        //         maxRetries: 5,
        //         delaySeconds: 1,
        //       },
        //     ],
        //   },
        // ];
        const events = list.list;
        const nextUrl = list.continuationToken
          ? (() => {
              const query = new URLSearchParams();
              query.set("cursor", list.continuationToken);
              if (maxItems !== 5) {
                query.set("pageSize", maxItems.toString());
              }
              return `/?${query.toString()}`;
            })()
          : undefined;

        return c.render(
          <div>
            <div class="h-2 bg-blue-300" />
            <div class="pb-6">
              <div class="mx-16 my-12 flex justify-between">
                <h1 class="text-3xl font-semibold pt-1">
                  cf-eventhub:
                  <span class="ml-2 text-gray-500">web console</span>
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

              <div class="flex flex-col justify-center gap-12 overflow-hidden pt-1 pb-6">
                {events.length > 0 ? (
                  events.map((e) => (
                    <Event
                      key={e.id}
                      event={e}
                      formatDate={c.var.dateFormatter}
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
                />
              </div>
            </div>
          </div>,
        );
      },
    );
