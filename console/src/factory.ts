import type { EventHub } from "cf-eventhub";
import { createFactory } from "hono/factory";

export type DateTime = Date | string;

export type Env = {
  Bindings: Record<string, unknown>;
  Variables: {
    dateFormatter: (d: DateTime) => string;
    dateRangeFormatter: (d1: DateTime, d2: DateTime) => string;
    eventHubBinding: DurableObjectNamespace<EventHub>;
    eventHubInstance: string;
    getEventHub: () => DurableObjectStub<EventHub>;
  };
};

export const factory = createFactory<Env>();
