import type {
  Destinations,
  R2Destination,
  ResolvedDestination,
  RoutingStrategy,
} from "./routing";
import type { PendingDeliveryJobs, PersistedDeliveryJob } from "./store";
import type { EventPayload } from "./type";

const MAX_SEND_BATCH_COUNT = 100;

// A persisted delivery job with its resolved delivery target.
export type DeliveryJob<Env extends object> = Omit<
  PersistedDeliveryJob,
  "destination"
> & {
  target: ResolvedDestination;
  destination: Destinations<Env>;
};

// Lifecycle callbacks fired after each batch delivery attempt.
type DeliverJobsHandlers = {
  onDelivered: (jobIds: readonly string[]) => void | Promise<void>;
  onFailed: (jobIds: readonly string[], error: unknown) => void | Promise<void>;
};

// Groups jobs so each queue can be sent in destination-local batches.
const groupJobsByDestination = <T extends { destination: string }>(
  jobs: readonly T[],
): Map<string, T[]> => {
  const grouped = new Map<string, T[]>();
  for (const job of jobs) {
    const destinationJobs = grouped.get(job.destination);
    if (destinationJobs) {
      destinationJobs.push(job);
    } else {
      grouped.set(job.destination, [job]);
    }
  }
  return grouped;
};

// Attaches delivery bindings to persisted jobs before sending them.
export const resolveDeliveryJobs = <Env extends object>(
  routing: RoutingStrategy<Env>,
  jobs: readonly PersistedDeliveryJob[],
): DeliveryJob<Env>[] => {
  const targetsByDestination = new Map<
    Destinations<Env>,
    ResolvedDestination
  >();
  const destinations = new Set<Destinations<Env>>();

  for (const { destination } of jobs) {
    destinations.add(destination as Destinations<Env>);
  }

  for (const destination of destinations) {
    targetsByDestination.set(
      destination,
      routing.resolveDestination(destination),
    );
  }

  return jobs.map((job) => {
    const destination = job.destination as Destinations<Env>;
    const target = targetsByDestination.get(destination);
    if (!target) {
      throw new Error(`eventhub: ${job.destination} not resolved`);
    }

    return {
      ...job,
      destination,
      target,
    };
  });
};

// Fails fast if any configured destination binding is missing.
export const assertDestinationBindingsExist = <Env extends object>(
  routing: RoutingStrategy<Env>,
  pendingDeliveryJobs: PendingDeliveryJobs,
): void => {
  const destinations = new Set<Destinations<Env>>();

  for (const { destinations: items } of pendingDeliveryJobs.payloads) {
    for (const destination of items) {
      destinations.add(destination as Destinations<Env>);
    }
  }

  for (const destination of destinations) {
    routing.resolveDestination(destination);
  }
};

type DeliveryMetadataSource = {
  instanceId: string;
  instanceName?: string;
};

type DeliveryContext = DeliveryMetadataSource & {
  includeDeliveryMetadata: boolean;
};

const getR2ObjectKey = <Env extends object>(
  job: DeliveryJob<Env>,
  target: R2Destination,
  context: DeliveryContext,
): string => {
  const key =
    target.objectKey === undefined
      ? `${job.payloadId}/${job.id}.json`
      : target.objectKey({
          payload: job.payload,
          payloadId: job.payloadId,
          deliveryJobId: job.id,
          destination: String(job.destination),
          instanceId: context.instanceId,
          ...(context.instanceName === undefined
            ? {}
            : { instanceName: context.instanceName }),
        });

  if (typeof key !== "string" || key.length === 0) {
    throw new Error("eventhub: R2 object key must be a non-empty string");
  }
  return key;
};

// Adds authoritative instance and job IDs while preserving other metadata.
const injectDeliveryMetadata = (
  payload: EventPayload,
  jobId: string,
  source: DeliveryMetadataSource,
): EventPayload => {
  const existing = payload.__eventhub__;
  const customMetadata: Record<string, unknown> =
    typeof existing === "object" &&
    existing !== null &&
    !Array.isArray(existing)
      ? Object.fromEntries(
          Object.entries(existing).filter(
            ([key]) =>
              key !== "deliveryJobId" &&
              key !== "instanceId" &&
              key !== "instanceName",
          ),
        )
      : {};
  const eventhubMetadata = {
    ...customMetadata,
    deliveryJobId: jobId,
    instanceId: source.instanceId,
    ...(source.instanceName === undefined
      ? {}
      : { instanceName: source.instanceName }),
  };

  return {
    ...payload,
    __eventhub__: eventhubMetadata,
  };
};

const deliverQueueJobs = async <Env extends object>(
  jobs: readonly DeliveryJob<Env>[],
  queue: Queue<EventPayload>,
  handlers: DeliverJobsHandlers,
  context: DeliveryContext,
): Promise<void> => {
  for (let i = 0; i < jobs.length; i += MAX_SEND_BATCH_COUNT) {
    const chunk = jobs.slice(i, i + MAX_SEND_BATCH_COUNT);
    const jobIds = chunk.map((job) => job.id);
    try {
      await queue.sendBatch(
        chunk.map((job) => ({
          body: context.includeDeliveryMetadata
            ? injectDeliveryMetadata(job.payload, job.id, context)
            : job.payload,
          contentType: "json",
        })),
      );
      await handlers.onDelivered(jobIds);
    } catch (error) {
      await handlers.onFailed(jobIds, error);
    }
  }
};

const deliverR2Jobs = async <Env extends object>(
  jobs: readonly DeliveryJob<Env>[],
  target: R2Destination,
  handlers: DeliverJobsHandlers,
  context: DeliveryContext,
): Promise<void> => {
  for (const job of jobs) {
    try {
      const payloadToStore = context.includeDeliveryMetadata
        ? injectDeliveryMetadata(job.payload, job.id, context)
        : job.payload;

      await target.bucket.put(
        getR2ObjectKey(job, target, context),
        JSON.stringify(payloadToStore),
        {
          httpMetadata: {
            contentType: "application/json",
          },
        },
      );
      await handlers.onDelivered([job.id]);
    } catch (error) {
      await handlers.onFailed([job.id], error);
    }
  }
};

// Sends jobs in destination-local units and reports success or failure per attempt.
export const deliverJobs = async <Env extends object>(
  jobs: readonly DeliveryJob<Env>[],
  handlers: DeliverJobsHandlers,
  context: DeliveryContext,
): Promise<void> => {
  for (const destinationJobs of groupJobsByDestination(jobs).values()) {
    const [{ target }] = destinationJobs;
    if (target.kind === "queue") {
      await deliverQueueJobs(destinationJobs, target.queue, handlers, context);
      continue;
    }
    await deliverR2Jobs(destinationJobs, target, handlers, context);
  }
};

// Resolves queues per destination and keeps other destinations moving on failure.
export const deliverPersistedJobs = async <Env extends object>(
  routing: RoutingStrategy<Env>,
  jobs: readonly PersistedDeliveryJob[],
  handlers: DeliverJobsHandlers,
  context: DeliveryContext,
): Promise<void> => {
  for (const destinationJobs of groupJobsByDestination(jobs).values()) {
    try {
      await deliverJobs(
        resolveDeliveryJobs(routing, destinationJobs),
        handlers,
        context,
      );
    } catch (error) {
      await handlers.onFailed(
        destinationJobs.map((job) => job.id),
        error,
      );
    }
  }
};
