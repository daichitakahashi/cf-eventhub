import type { FC } from "hono/jsx";

import { ScanSearch, Sunrise } from "../components/Icon";
import { Modal } from "../components/Modal";
import { StatusIndicator } from "../components/StatusIndicator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/Table";
import { Textarea } from "../components/Textarea";
import type { EventWithDispatches } from "../components/types";
import { Button } from "./Button";
import { Description, DescriptionList } from "./DescriptionList";

export const Event: FC<{
  event: EventWithDispatches;
  formatDate: (d: Date | Rpc.Provider<Date>) => string;
}> = ({ event, formatDate }) => (
  <div class="mx-16 rounded-lg bg-white px-6 py-4 ring-1 ring-gray-900/20 drop-shadow">
    <div class="flex justify-between font-semibold leading-7">
      <div class="flex place-items-center gap-2">
        <StatusIndicator status="complete" />
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

export const Dispatch: FC<{
  dispatch: EventWithDispatches["dispatches"][number];
  formatDate: (d: Date | Rpc.Provider<Date>) => string;
}> = ({ dispatch, formatDate }) => (
  <TableRow>
    <TableCell>
      <code>{dispatch.destination}</code>
    </TableCell>
    <TableCell>
      <div class="flex gap-1 items-center">
        <StatusIndicator status="complete" />
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
      <Modal
        target={(_: string) => (
          <div class="w-fit cursor-pointer hover:text-gray-500" _={_}>
            <ScanSearch title="Show detail" />
          </div>
        )}
      >
        {(_) => (
          <DispatchDetails
            dispatch={dispatch}
            closeModal={_}
            formatDate={formatDate}
          />
        )}
      </Modal>
    </TableCell>
  </TableRow>
);

const DispatchDetails: FC<{
  dispatch: EventWithDispatches["dispatches"][number];
  closeModal: string;
  formatDate: (d: Date | Rpc.Provider<Date>) => string;
}> = ({ dispatch, closeModal, formatDate }) => (
  <div>
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
        <Description title="Max retries">{dispatch.maxRetries}</Description>
        <Description title="Delay seconds">
          {dispatch.delaySeconds || "-"}
        </Description>
        <Description title="Status">
          <div class="flex gap-1 items-center">
            <StatusIndicator status="complete" />
            {dispatch.status}
          </div>
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
        _="on htmx:beforeSend add @disabled='true'"
      >
        Retry as new dispatch
      </Button>
      <Button type="button" _={closeModal} secondary>
        Close
      </Button>
    </div>
  </div>
);
