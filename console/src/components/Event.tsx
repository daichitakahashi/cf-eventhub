import type { FC } from "hono/jsx";

import type { DateTime } from "../factory";
import { Button } from "./Button";
import { Description, DescriptionList } from "./DescriptionList";
import { ScanSearch, SunMedium, Sunrise } from "./Icon";
import { StatusIndicator } from "./StatusIndicator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./Table";
import { Textarea } from "./Textarea";
import type { Dispatch, EventWithDispatches } from "./types";

const formatDispatchUpdatedAt = (dispatch: Dispatch): DateTime =>
  dispatch.finalizedAt ?? dispatch.lastFailedAt ?? dispatch.createdAt;

const formatAttempts = (dispatch: Dispatch): string =>
  dispatch.status === "ongoing"
    ? `${dispatch.retryCount} failures`
    : `${dispatch.retryCount + 1} attempts`;

const statusText = (dispatch: Dispatch): string => {
  if (dispatch.status === "ongoing") return "ongoing";
  if (dispatch.status === "completed") return "delivered";
  if (dispatch.status === "failed") return "consumer failed";
  return dispatch.status || "unknown";
};

export const Event: FC<{
  event: EventWithDispatches;
  formatDate: (d: DateTime) => string;
  eventTitle?: (e: EventWithDispatches) => string;
}> = ({ event, formatDate, eventTitle }) => {
  const title = eventTitle ? eventTitle(event) : event.id;
  const payload = JSON.stringify(event.payload, null, 4);
  const rows = payload.split("\n").length;
  return (
    <div
      id={`event-${event.id}`}
      class="mx-16 rounded-lg bg-white px-6 py-4 ring-1 ring-gray-900/20 drop-shadow"
    >
      <div class="flex justify-between font-semibold leading-7">
        <div class="flex place-items-center gap-1">
          <SunMedium title="" />
          <p class="text-gray-900">{title}</p>
        </div>
        <p class="text-gray-500">
          {event.createdAt ? formatDate(event.createdAt) : "-"}
        </p>
      </div>
      <div class="relative my-4 text-gray-500 flex flex-col">
        <Textarea rows={rows} readonly>
          {payload}
        </Textarea>
        <button
          class="
            absolute
            right-0
            px-2
            py-1
            mx-1
            my-1
            rounded-md
            hover:bg-gray-200
            active:outline
            active:outline-1
            active:bg-gray-400
            active:text-white
            text-sm
            select-none
          "
          type="button"
          data-copy-payload={JSON.stringify(event.payload)}
        >
          Copy to clipboard
        </button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Destination</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Attempts</TableHead>
            <TableHead>Last updated at</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody id={`event-dispatches-${event.id}`}>
          {event.dispatches.length > 0 ? (
            event.dispatches.map((dispatch) => (
              <DispatchRow
                key={dispatch.id}
                dispatch={dispatch}
                formatDate={formatDate}
              />
            ))
          ) : (
            <TableRow>
              <TableCell class="text-center pt-6 pb-2" colspan={5}>
                no dispatches.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
};

const DispatchRow: FC<{
  dispatch: Dispatch;
  formatDate: (d: DateTime) => string;
}> = ({ dispatch, formatDate }) => (
  <TableRow>
    <TableCell>
      <code>{dispatch.destination}</code>
    </TableCell>
    <TableCell>
      <div class="flex gap-1 items-center">
        <StatusIndicator status={dispatch.status} />
        {statusText(dispatch)}
      </div>
    </TableCell>
    <TableCell>{formatAttempts(dispatch)}</TableCell>
    <TableCell>{formatDate(formatDispatchUpdatedAt(dispatch))}</TableCell>
    <TableCell>
      <button
        type="button"
        class="w-fit cursor-pointer hover:text-gray-500"
        data-open-dispatch-detail={dispatch.id}
      >
        <ScanSearch title="Show detail" />
      </button>
      <template id={`dispatch-detail-${dispatch.id}`}>
        <DispatchDetails dispatch={dispatch} formatDate={formatDate} />
      </template>
    </TableCell>
  </TableRow>
);

export const DispatchDetails: FC<{
  dispatch: Dispatch;
  formatDate: (d: DateTime) => string;
}> = ({ dispatch, formatDate }) => (
  <div class={`dispatch-${dispatch.id}`}>
    <h2 class="text-2xl font-semibold">
      <span class="flex gap-2 items-center">
        <Sunrise title="" /> Dispatch details
      </span>
    </h2>
    <div class="my-6">
      <DescriptionList>
        <Description title="Dispatch ID">
          <code>{dispatch.id}</code>
        </Description>
        <Description title="Destination">
          <code>{dispatch.destination}</code>
        </Description>
        <Description title="Status">
          <div class="flex gap-1 items-center">
            <StatusIndicator status={dispatch.status} />
            {statusText(dispatch)}
          </div>
        </Description>
        <Description title="Created at">
          {formatDate(dispatch.createdAt)}
        </Description>
        <Description title="Finalized at">
          {dispatch.finalizedAt ? formatDate(dispatch.finalizedAt) : "-"}
        </Description>
        <Description title="Next retry at">
          {dispatch.status === "ongoing"
            ? formatDate(dispatch.nextRetryAt)
            : "-"}
        </Description>
        <Description title="Retry count">{dispatch.retryCount}</Description>
        <Description title="Final status">
          {dispatch.finalStatus ?? "-"}
        </Description>
        <Description title="Consumer failure reported at">
          {dispatch.failureReportedAt
            ? formatDate(dispatch.failureReportedAt)
            : "-"}
        </Description>
        <Description title="Last error">
          <pre class="whitespace-pre-wrap break-all">
            {dispatch.lastError ?? "-"}
          </pre>
        </Description>
      </DescriptionList>
    </div>
    <div class="flex gap-2">
      <form method="post" action={`/api/dispatches/${dispatch.id}/retry`}>
        <Button
          type="submit"
          data-confirm="Are you sure you wish to retry this dispatch?"
        >
          Retry as new dispatch
        </Button>
      </form>
      <Button type="button" data-close-dialog secondary>
        Close
      </Button>
    </div>
  </div>
);
