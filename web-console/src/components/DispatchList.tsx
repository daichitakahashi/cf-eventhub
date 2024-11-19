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
                  _={`on click add .is-active to #dialog:${dispatch.id}`}
                >
                  Open
                </button>
                <div
                  id={`dialog:${dispatch.id}`}
                  class="modal"
                  _={`
                    on keydown[key is 'Escape'] from window
                    if I match .is-active
                      remove .is-active from me
                    end
                  `}
                >
                  <div
                    class="modal-background"
                    _={`on click remove .is-active from #dialog:${dispatch.id}`}
                  />
                  <div class="modal-content">
                    <div class="card p-4">
                      <h3 class="title is-5 has-text-weight-semibold">
                        Dispatch details
                      </h3>
                      <h4 class="title is-6 has-text-weight-semibold my-2">
                        Payload
                      </h4>
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
                  </div>
                  <button
                    type="button"
                    class="modal-close is-large"
                    aria-label="close"
                    _={`on click remove .is-active from #dialog:${dispatch.id}`}
                  />
                </div>
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
