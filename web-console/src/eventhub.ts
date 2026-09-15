import type {
  EventHub,
  EventPayload,
  ListResult,
  ListedDeliveryJob,
} from "cf-eventhub";

export type DeliveryStatus =
  | "ongoing"
  | "completed"
  | "failed"
  | "consumer_failed";

export type ConsoleDeliveryJob = {
  id: string;
  payloadId: string;
  destination: string;
  status: DeliveryStatus;
  failedAttemptCount: number;
  createdAt: string;
  lastFailedAt: string | null;
  lastError: string | null;
  nextRetryAt: string;
  finalStatus: ListedDeliveryJob["finalStatus"];
  finalizedAt: string | null;
  failureReportedAt: string | null;
};

export type ConsoleEvent = {
  id: string;
  createdAt: string;
  payload: EventPayload;
  deliveryJobs: ConsoleDeliveryJob[];
};

export const toTimestamp = (value: string | null | undefined): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const getDeliveryJobUpdatedAt = (
  job: Pick<
    ListedDeliveryJob,
    "createdAt" | "failureReportedAt" | "finalizedAt" | "lastFailedAt"
  >,
): string => {
  const updates = [
    job.createdAt,
    job.finalizedAt,
    job.lastFailedAt,
    job.failureReportedAt,
  ].filter((value): value is string => value !== null);
  return updates.reduce((latest, value) =>
    toTimestamp(value) > toTimestamp(latest) ? value : latest,
  );
};

export const getEventsLastUpdatedAt = (events: ConsoleEvent[]): number =>
  events.reduce(
    (lastUpdatedAt, event) =>
      Math.max(
        lastUpdatedAt,
        toTimestamp(event.createdAt),
        ...event.deliveryJobs.map((job) =>
          toTimestamp(getDeliveryJobUpdatedAt(job)),
        ),
      ),
    0,
  );

export const formatDeliveryAttempts = (
  job: Pick<ConsoleDeliveryJob, "failedAttemptCount" | "finalStatus">,
): string => {
  if (job.finalStatus === null) {
    return `${job.failedAttemptCount} ${job.failedAttemptCount === 1 ? "failure" : "failures"}`;
  }

  const attempts =
    job.finalStatus === "completed"
      ? job.failedAttemptCount + 1
      : job.failedAttemptCount;
  return `${attempts} ${attempts === 1 ? "attempt" : "attempts"}`;
};

export const normalizeEvents = (result: ListResult): ConsoleEvent[] =>
  result.payloads.map((item) => ({
    id: item.payloadId,
    createdAt: item.createdAt,
    payload: item.payload,
    deliveryJobs: item.deliveryJobs.map((job) => ({
      id: job.id,
      payloadId: job.payloadId,
      destination: job.destination,
      status: job.failureReportedAt
        ? "consumer_failed"
        : job.finalStatus || "ongoing",
      failedAttemptCount: job.failedAttemptCount,
      createdAt: job.createdAt,
      lastFailedAt: job.lastFailedAt,
      lastError: job.lastError,
      nextRetryAt: job.nextRetryAt,
      finalStatus: job.finalStatus,
      finalizedAt: job.finalizedAt,
      failureReportedAt: job.failureReportedAt,
    })),
  }));
