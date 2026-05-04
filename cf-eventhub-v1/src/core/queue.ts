import type { PendingDeliveryJobs, PersistedDeliveryJob } from "./store";
import type { EventPayload } from "./type";

const MAX_SEND_BATCH_COUNT = 100;

export type DeliveryJob = PersistedDeliveryJob & {
	queue: Queue<EventPayload>;
};

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

export const deliverJobs = async (
	jobs: readonly DeliveryJob[],
	onDelivered?: (jobIds: readonly number[]) => void | Promise<void>,
): Promise<void> => {
	const jobsByDestination = new Map<string, DeliveryJob[]>();

	for (const job of jobs) {
		const items = jobsByDestination.get(job.destination) ?? [];
		items.push(job);
		jobsByDestination.set(job.destination, items);
	}

	for (const destinationJobs of jobsByDestination.values()) {
		const [{ queue }] = destinationJobs;
		for (let i = 0; i < destinationJobs.length; i += MAX_SEND_BATCH_COUNT) {
			const chunk = destinationJobs.slice(i, i + MAX_SEND_BATCH_COUNT);
			await queue.sendBatch(
				chunk.map((job) => ({
					body: job.payload,
					contentType: "json",
				})),
			);
			await onDelivered?.(chunk.map((job) => job.id));
		}
	}
};
