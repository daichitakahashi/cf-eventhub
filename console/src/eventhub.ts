import type {
  EventPayload,
  ListResult,
  ListedDeliveryJob,
} from "eventhub/src";

import type { Env } from "./factory";

export type DispatchStatus = "ongoing" | "complete" | "failed" | "lost";

export type ConsoleDispatch = {
  id: string;
  payloadId: string;
  destination: string;
  status: DispatchStatus;
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
  dispatches: ConsoleDispatch[];
};

export const getHub = (env: Env["Bindings"], hubName: string) =>
  env.EVENT_HUB.get(env.EVENT_HUB.idFromName(hubName));

export const toTimestamp = (value: string | null | undefined): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const toDispatchStatus = (job: ListedDeliveryJob): DispatchStatus => {
  if (job.finalStatus === null) return "ongoing";
  if (job.finalStatus === "completed") {
    return job.failureReportedAt ? "lost" : "complete";
  }
  return "failed";
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
      createdAt === null ? `payload-no-dispatch-${index}` : `payload-${index}`;
    return {
      id: item.deliveryJobs[0]?.payloadId ?? fallbackId,
      createdAt,
      payload: item.payload,
      dispatches: item.deliveryJobs.map((job) => ({
        id: job.id,
        payloadId: job.payloadId,
        destination: job.destination,
        status: toDispatchStatus(job),
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
