import { type FC, Fragment } from "hono/jsx";

import { DispatchStatus } from "./DispatchStatus";
import type { Dispatch, ListDispatchesResult } from "./types";

interface Props {
  initial: ListDispatchesResult;
  formatDate: (d: Date | Rpc.Provider<Date>) => string;
}

export const DispatchList: FC<Props> = ({ initial, formatDate }) => {
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
        {initial.list.map((dispatch, i) => (
          <Fragment key={dispatch.id}>
            <DispatchRow dispatch={dispatch} formatDate={formatDate} />
            {i === lastIndex && initial.continuationToken && (
              <LoadNextDispatches
                continuationToken={initial.continuationToken}
              />
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
};

export const DispatchRow: FC<{
  dispatch: Dispatch;
  formatDate: (d: Date | Rpc.Provider<Date>) => string;
}> = ({ dispatch, formatDate }) => (
  <tr>
    <td>{dispatch.destination}</td>
    <td>{formatDate(dispatch.createdAt)}</td>
    <td>
      {dispatch.executionLog.length > 0
        ? formatDate(
            dispatch.executionLog[dispatch.executionLog.length - 1].executedAt,
          )
        : "-"}
    </td>
    <td>
      <DispatchStatus status={dispatch.status} />
    </td>
    <td>
      <button
        class="button is-small is-dark is-rounded"
        type="button"
        hx-trigger="click once"
        hx-get={`/api/events/${dispatch.eventId}`}
        hx-target={`#payload--${dispatch.id}`}
        hx-swap="innerHTML"
        _={`
          on click
          add .is-active to #dialog--${dispatch.id}
          then add .is-clipped to <html/>
        `}
      >
        Open
      </button>
      <div
        id={`dialog--${dispatch.id}`}
        class="modal"
        _={`
          on keydown[key is 'Escape'] from window
          if I match .is-active
            remove .is-active from me
            then remove .is-clipped from <html/>
          end
        `}
      >
        <div
          class="modal-background"
          _={`
            on click
            remove .is-active from #dialog--${dispatch.id}
            then remove .is-clipped from <html/>
          `}
        />
        <div class="modal-content">
          <div
            class="card p-4"
            style={{
              maxHeight: "80vh",
              overflow: "scroll",
            }}
          >
            <div class="container my-2">
              <h3 class="title is-5 has-text-weight-semibold">
                <div class="is-flex is-justify-content-space-between">
                  <div class="mr-2">Dispatch details:</div>
                  <div class="tag is-success is-light is-medium">
                    {dispatch.id}
                  </div>
                </div>
              </h3>
              <div class="fixed-grid has-4-cols">
                <div class="grid">
                  <div class="cell has-text-weight-semibold">Destination:</div>
                  <div class="cell is-col-span-3">{dispatch.destination}</div>
                  <div class="cell has-text-weight-semibold">Created at:</div>
                  <div class="cell is-col-span-3">
                    {formatDate(dispatch.createdAt)}
                  </div>
                  <div class="cell has-text-weight-semibold">Status:</div>
                  <div class="cell is-col-span-3">
                    <DispatchStatus status={dispatch.status} size="small" />
                  </div>
                  <div class="cell has-text-weight-semibold">
                    Delay seconds:
                  </div>
                  <div class="cell is-col-span-3">
                    {dispatch.delaySeconds || "-"}
                  </div>
                  <div class="cell has-text-weight-semibold">Max retries:</div>
                  <div class="cell is-col-span-3">
                    {dispatch.maxRetries || "-"}
                  </div>
                  {dispatch.executionLog.length > 0 ? (
                    dispatch.executionLog.map((execution, i) => (
                      <Fragment key={`${dispatch.id}-${i}`}>
                        <div class="cell has-text-weight-semibold">
                          {i === 0 ? "Executions:" : null}
                        </div>
                        <div
                          class="cell is-col-span-3 is-flex"
                          style={{ gap: "0.5em" }}
                        >
                          <div>
                            {`${i + 1}. `}
                            <span class="has-text-weight-semibold">
                              {execution.result}
                            </span>
                          </div>
                          <div>at</div>
                          <div>{formatDate(execution.executedAt)}</div>
                        </div>
                      </Fragment>
                    ))
                  ) : (
                    <>
                      <div class="cell has-text-weight-semibold">
                        Executions:
                      </div>
                      <div class="cell is-col-span-3">-</div>
                    </>
                  )}
                  <div class="cell has-text-weight-semibold">Event ID:</div>
                  <div class="cell is-col-span-3">{dispatch.eventId}</div>
                  <div class="cell has-text-weight-semibold">
                    Event payload:
                  </div>
                  <div class="cell is-col-span-4">
                    <textarea
                      id={`payload--${dispatch.id}`}
                      class="textarea is-dark"
                      rows={10}
                      readonly
                    >
                      {}
                    </textarea>
                  </div>
                </div>
              </div>
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
        </div>
        <button
          type="button"
          class="modal-close is-large"
          aria-label="close"
          _={`
            on click
            remove .is-active from #dialog--${dispatch.id}
            then remove .is-clipped from <html/>
          `}
        />
      </div>
    </td>
  </tr>
);

export const LoadNextDispatches: FC<{
  continuationToken: string;
}> = ({ continuationToken }) => (
  <tr id="load-next-dispatches">
    <td
      colspan={5}
      hx-get={`/api/dispatches?token=${encodeURIComponent(continuationToken)}`}
      hx-trigger="intersect"
      hx-target="#load-next-dispatches"
      hx-swap="outerHTML"
    >
      <progress class="progress is-small is-light my-4" max="100" />
    </td>
  </tr>
);
