import type {
  EventHub,
  EventHubInstance,
  EventHubRegistry,
  ResultError,
} from "cf-eventhub";
import { createFactory } from "hono/factory";

export type DateTime = Date | string;
export type UrlValues = Record<
  string,
  string | number | boolean | null | undefined
>;

export type Env = {
  Bindings: Record<string, unknown>;
  Variables: {
    dateFormatter: (d: DateTime) => string;
    dateRangeFormatter: (d1: DateTime, d2: DateTime) => string;
    eventHubBinding: DurableObjectNamespace<EventHub>;
    registryBinding: DurableObjectNamespace<EventHubRegistry>;
    registry: DurableObjectStub<EventHubRegistry>;
    hasInstances: boolean;
    selectedInstance?: EventHubInstance;
    requestedInstance?: string;
    registryError?: ResultError["error"] | { message: string };
    getEventHub: () => DurableObjectStub<EventHub> | undefined;
    buildUrl: (path: string, values?: UrlValues) => string;
  };
};

export const factory = createFactory<Env>();
