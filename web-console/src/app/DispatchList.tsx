import { Fragment, type FC } from "hono/jsx";

import type { RpcEventHub } from "../../../cf-eventhub/src/core/hub/rpc";

interface Props {
  initial: Awaited<ReturnType<Service<RpcEventHub>["listDispatches"]>>;
}

// TODO: Dispatch details(Component).
//    Component is reused in tha /api/dispatches
// TODO: InfiniteScrollTrigger component
//    Also, it is reused in the /api/dispatches
// TODO: How to see event payload.

export const DispatchList: FC<Props> = ({ initial }) => {
  const lastIndex = initial.list.length - 1;
  return (
    <div>
      <form
        id="retry"
        hx-post="/api/dispatches/retry"
        hx-trigger="click from:button"
        hx-confirm="Are you sure you wish to retry selected dispatches?"
      >
        <a href="/publish">Publish new event</a>
        <button type="submit">Retry selected dispatches</button>
      </form>
      <ul>
        {initial.list.map((dispatch, i) => {
          const item = () => (
            <label>
              <input
                type="checkbox"
                name="dispatchIds"
                form="retry"
                value={dispatch.id}
              />
              {dispatch.id}
            </label>
          );
          return (
            <Fragment key={dispatch.id}>
              <li>{item()}</li>
              {i === lastIndex && initial.continuationToken && (
                <div
                  hx-get={`/api/dispatches?token=${encodeURIComponent(initial.continuationToken)}`}
                  hx-trigger="intersect"
                  hx-swap="afterend"
                >
                  Loading...
                </div>
              )}
            </Fragment>
          );
        })}
      </ul>
    </div>
  );
};
