import type { PendingDeliveryJobs, PersistedDeliveryJob } from "./store";
import type { EventPayload } from "./type";

const MAX_SEND_BATCH_COUNT = 100;

// A persisted delivery job with its resolved destination queue.
export type DeliveryJob = PersistedDeliveryJob & {
	queue: Queue<EventPayload>;
};

// Lifecycle callbacks fired after each batch delivery attempt.
type DeliverJobsHandlers = {
	onDelivered?: (jobIds: readonly string[]) => void | Promise<void>;
	onFailed?: (
		jobIds: readonly string[],
		error: unknown,
	) => void | Promise<void>;
};

// Groups jobs so each queue can be sent in destination-local batches.
const groupJobsByDestination = <T extends { destination: string }>(
	jobs: readonly T[],
) => Map.groupBy(jobs, (j) => j.destination);

// Resolves a queue binding from the environment and validates its shape.
const getQueue = (
	env: Record<string, unknown>,
	name: string,
): Queue<EventPayload> => {
	const queue = env[name];
	if (!queue) {
		throw new Error(`cf-eventhub-v1: ${name} not set`);
	}
	if (typeof queue !== "object" || !("sendBatch" in queue)) {
		throw new Error(`cf-eventhub-v1: value of ${name} is not a Queue`);
	}
	return queue as Queue<EventPayload>;
};

// Attaches queue bindings to persisted jobs before sending them.
export const resolveDeliveryJobs = (
	env: Record<string, unknown>,
	jobs: readonly PersistedDeliveryJob[],
): DeliveryJob[] => {
	const queuesByDestination = new Map<string, Queue<EventPayload>>();

	for (const { destination } of jobs) {
		queuesByDestination.set(destination, getQueue(env, destination));
	}

	return jobs.map((job) => {
		const queue = queuesByDestination.get(job.destination);
		if (!queue) {
			throw new Error(`cf-eventhub-v1: ${job.destination} not resolved`);
		}

		return {
			...job,
			queue,
		};
	});
};

// Fails fast if any configured destination queue is missing.
export const assertQueuesExist = (
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
		getQueue(env, destination);
	}
};

// Sends jobs in queue batch units and reports success or failure per batch.
export const deliverJobs = async (
	jobs: readonly DeliveryJob[],
	handlers: DeliverJobsHandlers = {},
): Promise<void> => {
	for (const destinationJobs of groupJobsByDestination(jobs).values()) {
		const [{ queue }] = destinationJobs;
		for (let i = 0; i < destinationJobs.length; i += MAX_SEND_BATCH_COUNT) {
			const chunk = destinationJobs.slice(i, i + MAX_SEND_BATCH_COUNT);
			const jobIds = chunk.map((job) => job.id);
			try {
				await queue.sendBatch(
					chunk.map((job) => ({
						body: job.payload,
						contentType: "json",
					})),
				);
				await handlers.onDelivered?.(jobIds);
			} catch (error) {
				await handlers.onFailed?.(jobIds, error);
			}
		}
	}
};

// Resolves queues per destination and keeps other destinations moving on failure.
export const deliverPersistedJobs = async (
	env: Record<string, unknown>,
	jobs: readonly PersistedDeliveryJob[],
	handlers: DeliverJobsHandlers = {},
): Promise<void> => {
	for (const destinationJobs of groupJobsByDestination(jobs).values()) {
		try {
			await deliverJobs(resolveDeliveryJobs(env, destinationJobs), handlers);
		} catch (error) {
			await handlers.onFailed?.(
				destinationJobs.map((job) => job.id),
				error,
			);
		}
	}
};
