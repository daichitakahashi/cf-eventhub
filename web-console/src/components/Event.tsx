import type { FC } from "hono/jsx";

import type { DateTime } from "../factory";
import { Button } from "./Button";
import { Description, DescriptionList } from "./DescriptionList";
import { ScanSearch, Sunrise } from "./Icon";
import { SharedModalContent, type SharedModalData } from "./Modal";
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
import type { EventWithDispatches } from "./types";

export const Event: FC<{
  event: EventWithDispatches;
  formatDate: (d: DateTime) => string;
  sharedModal: SharedModalData;
}> = ({ event, formatDate, sharedModal }) => {
  let eventStatus: "ongoing" | "complete" | "ignored" | "failed" = "ongoing";
  const statuses = event.dispatches
    .map((d) => d.status)
    .filter((s) => s !== "ignored");
  if (statuses.length === 0) {
    eventStatus = "ignored";
  } else if (statuses.some((s) => s === "ongoing")) {
    eventStatus = "ongoing";
  } else if (statuses.every((s) => s === "complete")) {
    eventStatus = "complete";
  } else if (
    statuses.some(
      (s) => s === "failed" || s === "misconfigured" || s === "lost",
    )
  ) {
    eventStatus = "failed";
  }
  return (
    <div
      id={`event-${event.id}`}
      class="mx-16 rounded-lg bg-white px-6 py-4 ring-1 ring-gray-900/20 drop-shadow"
      hx-swap-oob={`#event-${event.id}`}
    >
      <div class="flex justify-between font-semibold leading-7">
        <div class="flex place-items-center gap-2">
          <StatusIndicator status={eventStatus} />
          <p class="text-gray-900">{formatDate(event.createdAt)}</p>
        </div>
        <p class="text-gray-500">{event.id}</p>
      </div>
      <div class="my-4 text-gray-500">
        <Textarea readonly>{JSON.stringify(event.payload, null, 4)}</Textarea>
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
        <TableBody>
          {event.dispatches.length > 0 ? (
            event.dispatches.map((dispatch) => (
              <Dispatch
                key={dispatch.id}
                dispatch={dispatch}
                formatDate={formatDate}
                sharedModal={sharedModal}
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

export const Dispatch: FC<{
  dispatch: EventWithDispatches["dispatches"][number];
  formatDate: (d: DateTime) => string;
  sharedModal: SharedModalData;
}> = ({ dispatch, formatDate, sharedModal }) => (
  <TableRow>
    <TableCell>
      <code>{dispatch.destination}</code>
    </TableCell>
    <TableCell>
      <div class="flex gap-1 items-center">
        <StatusIndicator status={dispatch.status} />
        {dispatch.status}
      </div>
    </TableCell>
    <TableCell>
      {dispatch.executionLog.length} / {dispatch.maxRetries + 1}
    </TableCell>
    <TableCell>
      {formatDate(
        dispatch.executionLog.length > 0
          ? dispatch.executionLog[dispatch.executionLog.length - 1].executedAt
          : dispatch.createdAt,
      )}
    </TableCell>
    <TableCell>
      <SharedModalContent
        sharedModal={sharedModal}
        contentFrameId={`dispatch-${dispatch.id}`}
        trigger={(openModal) => (
          <div
            class="w-fit cursor-pointer hover:text-gray-500"
            hx-swap-oob={`.dispatch-${dispatch.id}`}
            _={openModal}
          >
            <ScanSearch title="Show detail" />
          </div>
        )}
      >
        {(closeModal) => (
          <DispatchDetails
            dispatch={dispatch}
            closeModal={closeModal}
            formatDate={formatDate}
          />
        )}
      </SharedModalContent>
    </TableCell>
  </TableRow>
);

const DispatchDetails: FC<{
  dispatch: EventWithDispatches["dispatches"][number];
  closeModal: string;
  formatDate: (d: DateTime) => string;
}> = ({ dispatch, closeModal, formatDate }) => (
  <div class={`dispatch-${dispatch.id}`}>
    <h2 class="text-2xl font-semibold">
      <span class="flex gap-2 items-center">
        <Sunrise title="" /> Dispatch details
      </span>
    </h2>
    <div class="my-6">
      <DescriptionList>
        <Description title="Destination">
          <code>{dispatch.destination}</code>
        </Description>
        <Description title="Status">
          <div class="flex gap-1 items-center">
            <StatusIndicator status={dispatch.status} />
            {dispatch.status}
          </div>
        </Description>
        <Description title="Delay seconds">
          {dispatch.delaySeconds} sec
        </Description>
        <Description title="Max retries">{dispatch.maxRetries}</Description>
        <Description title="Retry delay">
          {dispatch.retryDelay.type === "exponential" ? (
            <>
              <p class="font-bold">
                Exponential backoff with decorrelated jitter
              </p>
              <p>{`base: ${dispatch.retryDelay.base} sec, max: ${dispatch.retryDelay.max} sec`}</p>
            </>
          ) : (
            <>
              <p class="font-bold">Fixed</p>
              <p>{`interval: ${dispatch.retryDelay.interval} sec`}</p>
            </>
          )}
        </Description>
        <Description title="Attempts">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>No.</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>ExecutedAt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dispatch.executionLog.map((e, i) => (
                <TableRow key={`${dispatch.id}-${i}`}>
                  <TableCell>{i + 1}.</TableCell>
                  <TableCell>{e.result}</TableCell>
                  <TableCell>{formatDate(e.executedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Description>
      </DescriptionList>
    </div>
    <div class="flex gap-2">
      <Button
        type="button"
        hx-post={`/api/dispatches/${dispatch.id}/retry`}
        hx-confirm="Are you sure you wish to retry this dispatch?"
        hx-disabled-elt="this"
      >
        Retry as new dispatch
      </Button>
      <Button type="button" _={closeModal} secondary>
        Close
      </Button>
    </div>
  </div>
);
