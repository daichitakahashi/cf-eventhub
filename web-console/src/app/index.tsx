import { Style } from "hono/css";
import { jsxRenderer } from "hono/jsx-renderer";
import "typed-htmx";

import { CreateEvent } from "../components/CreateEvent";
import { DispatchList } from "../components/DispatchList";
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
      <title>cf-eventhub: Web Console</title>
      <Style />
      <link
        rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/bulma@1.0.2/css/versions/bulma-no-dark-mode.min.css"
        integrity="sha256-5EFzAidCiLYLhYi+0NhxgChTPLcx6lJlB6Qgym9maIg="
        crossorigin="anonymous"
      />
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
    <script type="text/javascript">const a = 0;</script>
    <body>
      <div class="container mt-4">
        <h1 class="title is-2 has-text-weight-semibold">
          cf-eventhub: Web Console
        </h1>
        {children}
      </div>
    </body>
  </html>
));

// TODO: localize
const f = new Intl.DateTimeFormat("ja", {
  dateStyle: "full",
  timeStyle: "long",
});
const dateFormatter = (d: Date | Rpc.Provider<Date>) => {
  return f.format(d as unknown as Date);
};

const handler = factory
  .createApp()
  .use(renderer)
  .use((c, next) => {
    c.set("dateFormatter", dateFormatter);
    return next();
  })
  .get("/", async (c) => {
    const initial = await c.env.EVENT_HUB.listDispatches({
      maxItems: 20,
      continuationToken: undefined,
      filterByStatus: undefined,
      orderBy: "CREATED_AT_DESC",
    });

    return c.render(
      <div>
        <h2 class="subtitle is-4 has-text-weight-semibold">
          Dispatches<span class="mx-2">/</span>
          <a class="has-text-grey is-underlined" href="/publish">
            Create new event
          </a>
        </h2>
        <DispatchList initial={initial} formatDate={c.get("dateFormatter")} />
      </div>,
    );
  })
  .get("/publish", async (c) => {
    return c.render(
      <div>
        <h2 class="subtitle is-4 has-text-weight-semibold">
          <a class="has-text-grey is-underlined" href="/">
            Dispatches
          </a>
          <span class="mx-2">/</span>Create new event
        </h2>
        <CreateEvent />
      </div>,
    );
  });

export default handler;
