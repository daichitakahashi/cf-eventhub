export { RouteConfig } from "./hub/routing";
export type { QueueMessage } from "./hub/queue";

export type Dispatch = {
  id: string;
  destination: string;
  createdAt: Date;
  payload: Record<string, unknown>;
  executionCount: number; // FIXME: Prefer execution log instead of execution count?
  maxRetryCount: number;
};
