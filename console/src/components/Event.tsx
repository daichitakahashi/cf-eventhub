import type { FC } from "hono/jsx";

import { getDeliveryJobUpdatedAt } from "../eventhub";
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
import type { DeliveryJob, EventWithDeliveryJobs } from "./types";

const formatAttempts = (job: DeliveryJob): string =>
  job.status === "ongoing"
    ? `${job.retryCount} failures`
    : `${job.retryCount + 1} attempts`;

const statusText = (job: DeliveryJob): string => {
  if (job.status === "ongoing") return "ongoing";
  if (job.status === "completed") return "delivered";
  if (job.status === "failed") return "delivery failed";
  if (job.status === "consumer_failed") return "consumer failed";
  return job.status;
};

export const Event: FC<{
  event: EventWithDeliveryJobs;
  formatDate: (d: DateTime) => string;
  eventTitle?: (e: EventWithDeliveryJobs) => string;
}> = ({ event, formatDate, eventTitle }) => {
  const title = eventTitle ? eventTitle(event) : event.id;
  const payload = JSON.stringify(event.payload, null, 4);
  const rows = payload.split("\n").length;
  return (
    <div
      id={`event-${event.id}`}
      class="md:mx-16 mx-6 rounded-lg bg-white px-6 py-4 ring-1 ring-gray-900/20 drop-shadow"
    >
      <div class="w-full flex justify-between gap-x-2 flex-wrap font-semibold leading-7">
        <div class="flex place-items-center gap-1">
          <SunMedium title="" />
          <p class="text-gray-900">{title}</p>
        </div>
        <p class="text-gray-500 text-nowrap">
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
            active:outline-1
            active:bg-gray-400
            active:text-white
            text-sm
            select-none
            cursor-pointer
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
        <TableBody id={`event-deliveryjobs-${event.id}`}>
          {event.deliveryJobs.length > 0 ? (
            event.deliveryJobs.map((job) => (
              <DeliveryJobRow key={job.id} job={job} formatDate={formatDate} />
            ))
          ) : (
            <TableRow>
              <TableCell class="text-center pt-6 pb-2" colspan={5}>
                no delivery jobs.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
};

const DeliveryJobRow: FC<{
  job: DeliveryJob;
  formatDate: (d: DateTime) => string;
}> = ({ job, formatDate }) => (
  <TableRow>
    <TableCell>
      <code>{job.destination}</code>
    </TableCell>
    <TableCell>
      <div class="flex gap-1 items-center">
        <StatusIndicator status={job.status} />
        {statusText(job)}
      </div>
    </TableCell>
    <TableCell>{formatAttempts(job)}</TableCell>
    <TableCell>{formatDate(getDeliveryJobUpdatedAt(job))}</TableCell>
    <TableCell>
      <button
        type="button"
        class="w-fit cursor-pointer hover:text-gray-500"
        data-open-deliveryjob-detail={job.id}
      >
        <ScanSearch title="Show detail" />
      </button>
      <template id={`deliveryjob-detail-${job.id}`}>
        <DeliveryJobDetails job={job} formatDate={formatDate} />
      </template>
    </TableCell>
  </TableRow>
);

export const DeliveryJobDetails: FC<{
  job: DeliveryJob;
  formatDate: (d: DateTime) => string;
}> = ({ job, formatDate }) => (
  <div class={`deliveryjob-${job.id}`}>
    <h2 class="text-2xl font-semibold">
      <span class="flex gap-2 items-center">
        <Sunrise title="" /> Delivery details
      </span>
    </h2>
    <div class="my-6">
      <DescriptionList>
        <Description title="Delivery job ID">
          <code>{job.id}</code>
        </Description>
        <Description title="Destination">
          <code>{job.destination}</code>
        </Description>
        <Description title="Status">
          <div class="flex gap-1 items-center">
            <StatusIndicator status={job.status} />
            {statusText(job)}
          </div>
        </Description>
        <Description title="Created at">
          {formatDate(job.createdAt)}
        </Description>
        <Description title="Finalized at">
          {job.finalizedAt ? formatDate(job.finalizedAt) : "-"}
        </Description>
        <Description title="Retry">
          <dl class="divide-y divide-gray-200">
            <div class="pb-2 sm:grid sm:grid-cols-3 sm:gap-4">
              <dt class="text-sm/6 text-gray-900">Next retry at</dt>
              <dd class="text-sm/6 text-gray-700 sm:col-span-2">
                {job.status === "ongoing" ? formatDate(job.nextRetryAt) : "-"}
              </dd>
            </div>
            <div class="py-2 sm:grid sm:grid-cols-3 sm:gap-4">
              <dt class="text-sm/6 text-gray-900">Retry count</dt>
              <dd class="text-sm/6 text-gray-700 sm:col-span-2">
                {job.retryCount}
              </dd>
            </div>
            <div class="pt-2 sm:grid sm:grid-cols-3 sm:gap-4">
              <dt class="text-sm/6 text-gray-900">Last delivery error</dt>
              <dd class="text-sm/6 text-gray-700 sm:col-span-2">
                {job.lastError ? (
                  <pre class="whitespace-pre-wrap break-all">
                    {job.lastError}
                  </pre>
                ) : (
                  "-"
                )}
              </dd>
            </div>
          </dl>
        </Description>
        <Description title="Consumer failure">
          {job.failureReportedAt
            ? `reported at ${formatDate(job.failureReportedAt)}`
            : "-"}
        </Description>
      </DescriptionList>
    </div>
    <div class="flex gap-2">
      <form method="post" action={`/api/delivery-jobs/${job.id}/retry`}>
        <Button
          type="submit"
          data-confirm="Are you sure you wish to redrive this delivery job?"
        >
          Redrive this delivery
        </Button>
      </form>
      <Button type="button" data-close-dialog secondary>
        Close
      </Button>
    </div>
  </div>
);
