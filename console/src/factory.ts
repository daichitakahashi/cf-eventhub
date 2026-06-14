import { createFactory } from "hono/factory";
import type { EventHub } from "eventhub/src";

export type DateTime = Date | string;

export type Env = {
  Bindings: {
    EVENT_HUB: DurableObjectNamespace<EventHub>;
  };
  Variables: {
    dateFormatter: (d: DateTime) => string;
    dateRangeFormatter: (d1: DateTime, d2: DateTime) => string;
    hubName: string;
  };
};

export const factory = createFactory<Env>();
