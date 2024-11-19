import { type FC, Fragment } from "hono/jsx";

import type { Dispatch, ListDispatchesResult } from "./types";

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
    <table class="table is-striped is-fullwidth is-hoverable">
      <thead>
        <tr>
          <th>Destination</th>
          <th>Created at</th>
          <th>Last execution</th>
          <th>Status</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        {initial.list.map((dispatch, i) => {
          const item = () => (
            <tr>
              <td>{dispatch.destination}</td>
              <td>{dispatch.createdAt.toISOString()}</td>
              <td>
                {dispatch.executionLog.length > 0
                  ? dispatch.executionLog[
                      dispatch.executionLog.length - 1
                    ].executedAt.toISOString()
                  : "-"}
              </td>
              <td>
                <span
                  class={`tag ${statusColor(dispatch.status)} is-medium has-text-weight-medium`}
                >
                  {dispatch.status}
                </span>
              </td>
              <td>
                <button
                  class="button is-small is-dark is-rounded"
                  type="button"
                  _={`
                      on click set dialog to #dialog:${dispatch.id}
                      if dialog does not match @open
                        call dialog.showModal()
                      end
                    `}
                >
                  Open
                </button>
                <dialog id={`dialog:${dispatch.id}`} class="container">
                  <div>
                    <h1>{dispatch.id}</h1>
                    <button
                      class="button is-text"
                      type="button"
                      _={`
                        on click set dialog to #dialog:${dispatch.id}
                        if dialog matches @open
                          call dialog.close()
                        end
                      `}
                    >
                      Close
                    </button>
                    <textarea
                      name="payload"
                      class="textarea is-dark mb-2"
                      rows={10}
                      readonly
                    >
                      {JSON.stringify(dispatch, null, 2)}
                    </textarea>
                    {dispatch.status !== "ongoing" && (
                      <button
                        class="button is-warning"
                        type="button"
                        hx-post={`/api/dispatches/${dispatch.id}/retry`}
                        hx-confirm="Are you sure you wish to retry this dispatch?"
                        _="on htmx:beforeSend add .is-loading then add @disabled='true'"
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </dialog>
              </td>
            </tr>
          );
          return (
            <Fragment key={dispatch.id}>
              {item()}
              {i === lastIndex && initial.continuationToken && (
                <tr>
                  <td
                    colspan={5}
                    hx-get={`/api/dispatches?token=${encodeURIComponent(initial.continuationToken)}`}
                    hx-trigger="intersect"
                    hx-swap="afterend"
                  >
                    <progress
                      class="progress is-small is-light my-4"
                      max="100"
                    />
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

const statusColor = (status: Dispatch["status"]) => {
  switch (status) {
    case "ongoing":
      return "is-info is-light";
    case "ignored":
      return "is-white";
    case "complete":
      return "is-success is-light";
    case "failed":
      return "is-danger";
    case "lost":
      return "is-danger";
    case "misconfigured":
      return "is-danger";
    default:
      return "is-light";
  }
};
