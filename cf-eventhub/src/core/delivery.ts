import { ULID_LENGTH } from "./id";
import type {
  Destinations,
  R2Destination,
  ResolvedDestination,
  RoutingStrategy,
} from "./routing";
import type { PendingDeliveryJobs, PersistedDeliveryJob } from "./store";
import type { EventPayload } from "./type";

const MAX_SEND_BATCH_COUNT = 100;
const MAX_SEND_BATCH_BYTES = 256_000;
const MAX_QUEUE_MESSAGE_BYTES = 128_000;
const DELIVERY_JOB_ID_PLACEHOLDER = "0".repeat(ULID_LENGTH);
const textEncoder = new TextEncoder();

// A persisted delivery job with its resolved delivery target.
export type DeliveryJob<Env extends object> = Omit<
  PersistedDeliveryJob,
  "destination"
> & {
  target: ResolvedDestination;
  destination: Destinations<Env>;
};

export type ResolvedDestinations<Env extends object> = ReadonlyMap<
  Destinations<Env>,
  ResolvedDestination
>;

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
  resolvedDestinations?: ResolvedDestinations<Env>,
): DeliveryJob<Env>[] => {
  const targetsByDestination = new Map(resolvedDestinations);
  const destinations = new Set<Destinations<Env>>();

  for (const { destination } of jobs) {
    destinations.add(destination as Destinations<Env>);
  }

  for (const destination of destinations) {
    if (!targetsByDestination.has(destination)) {
      targetsByDestination.set(
        destination,
        routing.resolveDestination(destination),
      );
    }
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
): ResolvedDestinations<Env> => {
  const destinations = new Set<Destinations<Env>>();
  const resolvedDestinations = new Map<
    Destinations<Env>,
    ResolvedDestination
  >();

  for (const { destinations: items } of pendingDeliveryJobs.payloads) {
    for (const destination of items) {
      destinations.add(destination as Destinations<Env>);
    }
  }

  for (const destination of destinations) {
    resolvedDestinations.set(
      destination,
      routing.resolveDestination(destination),
    );
  }
  return resolvedDestinations;
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

const getQueueMessageBody = (
  payload: EventPayload,
  jobId: string,
  context: DeliveryContext,
): EventPayload =>
  context.includeDeliveryMetadata
    ? injectDeliveryMetadata(payload, jobId, context)
    : payload;

const getJsonByteLength = (
  payload: EventPayload,
  serializedPayload?: string,
): number =>
  textEncoder.encode(serializedPayload ?? JSON.stringify(payload)).byteLength;

// Rejects Queue-bound payloads before publish persists any delivery state.
export const assertPendingQueueMessageSizes = <Env extends object>(
  resolvedDestinations: ResolvedDestinations<Env>,
  pendingDeliveryJobs: PendingDeliveryJobs,
  context: DeliveryContext,
): void => {
  for (const {
    payload,
    serializedPayload,
    destinations,
  } of pendingDeliveryJobs.payloads) {
    const hasQueueDestination = destinations.some(
      (destination) =>
        resolvedDestinations.get(destination as Destinations<Env>)?.kind ===
        "queue",
    );
    if (!hasQueueDestination) continue;

    const queuePayload = getQueueMessageBody(
      payload,
      DELIVERY_JOB_ID_PLACEHOLDER,
      context,
    );
    const bytes = getJsonByteLength(
      queuePayload,
      context.includeDeliveryMetadata ? undefined : serializedPayload,
    );
    if (bytes > MAX_QUEUE_MESSAGE_BYTES) {
      throw new Error(
        `eventhub: Queue message size ${bytes} bytes exceeds limit of ${MAX_QUEUE_MESSAGE_BYTES} bytes`,
      );
    }
  }
};

type QueueJob = {
  jobId: string;
  message: MessageSendRequest<EventPayload>;
};

const sendQueueBatch = async (
  batch: readonly QueueJob[],
  queue: Queue<EventPayload>,
  handlers: DeliverJobsHandlers,
): Promise<void> => {
  const jobIds = batch.map(({ jobId }) => jobId);
  try {
    await queue.sendBatch(batch.map(({ message }) => message));
    await handlers.onDelivered(jobIds);
  } catch (error) {
    await handlers.onFailed(jobIds, error);
  }
};

const deliverQueueJobs = async <Env extends object>(
  jobs: readonly DeliveryJob<Env>[],
  queue: Queue<EventPayload>,
  handlers: DeliverJobsHandlers,
  context: DeliveryContext,
): Promise<void> => {
  let batch: QueueJob[] = [];
  let batchBytes = 0;

  for (const job of jobs) {
    const body = getQueueMessageBody(job.payload, job.id, context);
    const bytes = getJsonByteLength(
      body,
      context.includeDeliveryMetadata ? undefined : job.serializedPayload,
    );

    if (bytes > MAX_QUEUE_MESSAGE_BYTES) {
      await handlers.onFailed(
        [job.id],
        new Error(
          `eventhub: Queue message size ${bytes} bytes exceeds limit of ${MAX_QUEUE_MESSAGE_BYTES} bytes`,
        ),
      );
      continue;
    }

    if (
      batch.length === MAX_SEND_BATCH_COUNT ||
      batchBytes + bytes > MAX_SEND_BATCH_BYTES
    ) {
      await sendQueueBatch(batch, queue, handlers);
      batch = [];
      batchBytes = 0;
    }

    batch.push({
      jobId: job.id,
      message: { body, contentType: "json" },
    });
    batchBytes += bytes;
  }

  if (batch.length > 0) {
    await sendQueueBatch(batch, queue, handlers);
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

      const serializedPayload = context.includeDeliveryMetadata
        ? JSON.stringify(payloadToStore)
        : (job.serializedPayload ?? JSON.stringify(payloadToStore));

      await target.bucket.put(
        getR2ObjectKey(job, target, context),
        serializedPayload,
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
  resolvedDestinations?: ResolvedDestinations<Env>,
): Promise<void> => {
  for (const destinationJobs of groupJobsByDestination(jobs).values()) {
    try {
      await deliverJobs(
        resolveDeliveryJobs(routing, destinationJobs, resolvedDestinations),
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
