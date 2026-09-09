import type {
  EventHub,
  EventHubInstance,
  EventHubInstanceStatus,
  EventHubRegistry,
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
    instances: EventHubInstance[];
    selectedInstance?: EventHubInstance;
    requestedInstance?: string;
    showStale: boolean;
    registryError?: string;
    getEventHub: () => DurableObjectStub<EventHub> | undefined;
    buildUrl: (path: string, values?: UrlValues) => string;
  };
};

export const factory = createFactory<Env>();

const MAX_REGISTRY_PAGES = 100;

export const listAllInstances = async (
  registry: DurableObjectStub<EventHubRegistry>,
  status: EventHubInstanceStatus,
): Promise<EventHubInstance[]> => {
  const instances: EventHubInstance[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_REGISTRY_PAGES; page += 1) {
    const result = await registry.list({ status, cursor, max: 100 });
    instances.push(...result.instances);
    if (!result.cursor) return instances;
    cursor = result.cursor;
  }
  throw new Error("EventHub Registry contains too many pages");
};
