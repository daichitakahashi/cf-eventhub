export { RouteConfig } from "./hub/routing";
export type { QueueMessage } from "./hub/queue";

export type EventPayload = Record<string, unknown>;

export type ExecutionResult =
  | "complete" // Succeeded to process event in destination worker.
  | "ignored" // Event is ignored by destination worker.
  | "failed" // Failed to process event in destination worker.
  | "misconfigured" // Destination worker not found.
  | "notfound"; // We cannot find the ongoing dispatch.
