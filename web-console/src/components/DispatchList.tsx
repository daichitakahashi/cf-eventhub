import { type FC, Fragment } from "hono/jsx";

import type { ListDispatchesResult } from "./types";

interface Props {
  initial: ListDispatchesResult;
}

// TODO: Dispatch details(Component).
//    Component is reused in tha /api/dispatches
// TODO: InfiniteScrollTrigger component
//    Also, it is reused in the /api/dispatches
// TODO: How to see event payload.

export const DispatchList: FC<Props> = ({ initial }) => {
  const lastIndex = initial.list.length - 1;
  return (
    <table>
      <thead>
        <tr>
          <th>Destination</th>
          <th>Created at</th>
          <th>Status</th>
          <th>Retry</th>
        </tr>
      </thead>
      <tbody>
        {initial.list.map((dispatch, i) => {
          const item = () => (
            <tr>
              <td>{dispatch.destination}</td>
              <td>{dispatch.createdAt}</td>
              <td>{dispatch.status}</td>
              <td>
                {dispatch.status !== "ongoing" && (
                  <button
                    type="button"
                    hx-post={`/api/dispatches/${dispatch.id}/retry`}
                    hx-confirm="Are you sure you wish to retry selected dispatch?"
                  >
                    Retry
                  </button>
                )}
              </td>
            </tr>
          );
          return (
            <Fragment key={dispatch.id}>
              {item()}
              {i === lastIndex && initial.continuationToken && (
                <tr>
                  <td
                    colspan={3}
                    hx-get={`/api/dispatches?token=${encodeURIComponent(initial.continuationToken)}`}
                    hx-trigger="intersect"
                    hx-swap="afterend"
                  >
                    Loading...
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
};
