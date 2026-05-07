import type { PendingDeliveryJobs, PersistedDeliveryJob } from "./store";
import type { EventPayload } from "./type";

const MAX_SEND_BATCH_COUNT = 100;

type QueueDestination = {
	kind: "queue";
	queue: Queue<EventPayload>;
};

type R2Destination = {
	kind: "r2";
	bucket: R2Bucket;
};

type DeliveryTarget = QueueDestination | R2Destination;

// A persisted delivery job with its resolved delivery target.
export type DeliveryJob = PersistedDeliveryJob & {
	target: DeliveryTarget;
};

// Lifecycle callbacks fired after each batch delivery attempt.
type DeliverJobsHandlers = {
	onDelivered: (jobIds: readonly string[]) => void | Promise<void>;
	onFailed: (jobIds: readonly string[], error: unknown) => void | Promise<void>;
};

// Groups jobs so each queue can be sent in destination-local batches.
const groupJobsByDestination = <T extends { destination: string }>(
	jobs: readonly T[],
) => Map.groupBy(jobs, (j) => j.destination);

const isQueue = (value: unknown): value is Queue<EventPayload> =>
	typeof value === "object" && value !== null && "sendBatch" in value;
const isR2Bucket = (value: unknown): value is R2Bucket =>
	typeof value === "object" &&
	value !== null &&
	"put" in value &&
	"createMultipartUpload" in value; // to distinguish between R2Bucket and KVNamespace(both instances have "put" method).

// Resolves a delivery binding from the environment and validates its shape.
const getDestinationBinding = (
	env: Record<string, unknown>,
	name: string,
): DeliveryTarget => {
	const binding = env[name];
	if (!binding) {
		throw new Error(`eventhub: ${name} not set`);
	}
	if (isQueue(binding)) {
		return {
			kind: "queue",
			queue: binding,
		};
	}
	if (isR2Bucket(binding)) {
		return {
			kind: "r2",
			bucket: binding,
		};
	}
	throw new Error(`eventhub: value of ${name} is not a Queue or R2Bucket`);
};

// Attaches delivery bindings to persisted jobs before sending them.
export const resolveDeliveryJobs = (
	env: Record<string, unknown>,
	jobs: readonly PersistedDeliveryJob[],
): DeliveryJob[] => {
	const targetsByDestination = new Map<string, DeliveryTarget>();

	for (const { destination } of jobs) {
		targetsByDestination.set(
			destination,
			getDestinationBinding(env, destination),
		);
	}

	return jobs.map((job) => {
		const target = targetsByDestination.get(job.destination);
		if (!target) {
			throw new Error(`eventhub: ${job.destination} not resolved`);
		}

		return {
			...job,
			target,
		};
	});
};

// Fails fast if any configured destination binding is missing.
export const assertDestinationBindingsExist = (
	env: Record<string, unknown>,
	pendingDeliveryJobs: PendingDeliveryJobs,
): void => {
	const destinations = new Set<string>();

	for (const { destinations: items } of pendingDeliveryJobs.payloads) {
		for (const destination of items) {
			destinations.add(destination);
		}
	}

	for (const destination of destinations) {
		getDestinationBinding(env, destination);
	}
};

const getR2ObjectKey = (job: PersistedDeliveryJob): string =>
	`${job.payloadId}/${job.id}.json`;

const deliverQueueJobs = async (
	jobs: readonly DeliveryJob[],
	queue: Queue<EventPayload>,
	handlers: DeliverJobsHandlers,
): Promise<void> => {
	for (let i = 0; i < jobs.length; i += MAX_SEND_BATCH_COUNT) {
		const chunk = jobs.slice(i, i + MAX_SEND_BATCH_COUNT);
		const jobIds = chunk.map((job) => job.id);
		try {
			await queue.sendBatch(
				chunk.map((job) => ({
					body: job.payload,
					contentType: "json",
				})),
			);
			await handlers.onDelivered(jobIds);
		} catch (error) {
			await handlers.onFailed(jobIds, error);
		}
	}
};

const deliverR2Jobs = async (
	jobs: readonly DeliveryJob[],
	bucket: R2Bucket,
	handlers: DeliverJobsHandlers,
): Promise<void> => {
	for (const job of jobs) {
		try {
			await bucket.put(getR2ObjectKey(job), JSON.stringify(job.payload), {
				httpMetadata: {
					contentType: "application/json",
				},
			});
			await handlers.onDelivered([job.id]);
		} catch (error) {
			await handlers.onFailed([job.id], error);
		}
	}
};

// Sends jobs in destination-local units and reports success or failure per attempt.
export const deliverJobs = async (
	jobs: readonly DeliveryJob[],
	handlers: DeliverJobsHandlers,
): Promise<void> => {
	for (const destinationJobs of groupJobsByDestination(jobs).values()) {
		const [{ target }] = destinationJobs;
		if (target.kind === "queue") {
			await deliverQueueJobs(destinationJobs, target.queue, handlers);
			continue;
		}
		await deliverR2Jobs(destinationJobs, target.bucket, handlers);
	}
};

// Resolves queues per destination and keeps other destinations moving on failure.
export const deliverPersistedJobs = async (
	env: Record<string, unknown>,
	jobs: readonly PersistedDeliveryJob[],
	handlers: DeliverJobsHandlers,
): Promise<void> => {
	for (const destinationJobs of groupJobsByDestination(jobs).values()) {
		try {
			await deliverJobs(resolveDeliveryJobs(env, destinationJobs), handlers);
		} catch (error) {
			await handlers.onFailed(
				destinationJobs.map((job) => job.id),
				error,
			);
		}
	}
};
