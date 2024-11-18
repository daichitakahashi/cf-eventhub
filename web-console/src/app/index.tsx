import { Style } from "hono/css";
import { jsxRenderer } from "hono/jsx-renderer";
import "typed-htmx";

import { factory } from "../factory";
import { DispatchList } from "./DispatchList";

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
      <script
        src="https://unpkg.com/htmx.org@2.0.3"
        integrity="sha384-0895/pl2MU10Hqc6jd4RvrthNlDiE9U1tWmX7WRESftEDRosgxNsQG/Ze9YMRzHq"
        crossorigin="anonymous"
      />
    </head>
    <script type="text/javascript">const a = 0;</script>
    <body>{children}</body>
  </html>
));

const handler = factory
  .createApp()
  .use(renderer)
  .get("/", async (c) => {
    const initial = await c.env.EVENT_HUB.listDispatches({
      maxItems: 50,
      continuationToken: undefined,
      filterByStatus: undefined,
    });

    return c.render(
      <DispatchList
        initial={{
          list: [
            {
              id: "1",
              eventId: "1",
              status: "ongoing",
              destination: "OKAYAMA",
              delaySeconds: 55,
              maxRetries: 55,
              executionLog: [],
              createdAt: new Date(),
            },
            {
              id: "2",
              eventId: "1",
              status: "ongoing",
              destination: "OKAYAMA",
              delaySeconds: 55,
              maxRetries: 55,
              executionLog: [],
              createdAt: new Date(),
            },
          ],
          continuationToken: "asdfafdasdf",
        }}
      />,
    );
  })
  .get("/publish", async (c) => {
    return c.render(<b>publish page</b>);
  });

export default handler;
