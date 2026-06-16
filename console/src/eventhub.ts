import type {
  EventHub,
  EventPayload,
  ListResult,
  ListedDeliveryJob,
} from "eventhub";

export type DeliveryStatus = "ongoing" | "completed" | "failed";

export type ConsoleDeliveryJob = {
  id: string;
  payloadId: string;
  destination: string;
  status: DeliveryStatus;
  retryCount: number;
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
  createdAt: string | null;
  payload: EventPayload;
  deliveryJobs: ConsoleDeliveryJob[];
};

export const toTimestamp = (value: string | null | undefined): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const toCreatedAt = (jobs: ListedDeliveryJob[]): string | null =>
  jobs.reduce<string | null>((oldest, job) => {
    if (!oldest || job.createdAt < oldest) return job.createdAt;
    return oldest;
  }, null);

export const normalizeEvents = (result: ListResult): ConsoleEvent[] =>
  result.payloads.map((item, index) => {
    const createdAt = toCreatedAt(item.deliveryJobs);
    const fallbackId =
      createdAt === null ? `payload-no-delivery-${index}` : `payload-${index}`;
    return {
      id: item.deliveryJobs[0]?.payloadId ?? fallbackId,
      createdAt,
      payload: item.payload,
      deliveryJobs: item.deliveryJobs.map((job) => ({
        id: job.id,
        payloadId: job.payloadId,
        destination: job.destination,
        status: job.finalStatus || "ongoing",
        retryCount: job.retryCount,
        createdAt: job.createdAt,
        lastFailedAt: job.lastFailedAt,
        lastError: job.lastError,
        nextRetryAt: job.nextRetryAt,
        finalStatus: job.finalStatus,
        finalizedAt: job.finalizedAt,
        failureReportedAt: job.failureReportedAt,
      })),
    };
  });
