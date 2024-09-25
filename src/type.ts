export { RouteConfig } from "./hub/routing";
export type { QueueMessage } from "./hub/queue";

export type EventPayload = Record<string, unknown>;

export type Dispatch = {
  id: string;
  destination: string;
  createdAt: Date;
  payload: EventPayload;
  executionCount: number; // FIXME: Prefer execution log instead of execution count?
  maxRetryCount: number;
};

export type ExecutionResult =
  | "succeeded" // Succeeded to process event in destination worker
  | "ignored" // Event is ignored by destination worker
  | "failed" // Failed to process event in destination worker
  | "lost" // Event is lost.
  | "misconfigured"; // Destination worker not found
