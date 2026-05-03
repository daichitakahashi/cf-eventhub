import type { EventPayload } from "./type";
import type { Config } from "./routing";
import { findRoutes } from "./routing";

const MAX_SEND_BATCH_COUNT = 100;

export type DeliveryJob = {
	queue: Queue<EventPayload>;
	messages: MessageSendRequest<EventPayload>[];
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

const sendBatches = async (
	queue: Queue<EventPayload>,
	messages: readonly MessageSendRequest<EventPayload>[],
): Promise<void> => {
	for (let i = 0; i < messages.length; i += MAX_SEND_BATCH_COUNT) {
		await queue.sendBatch(messages.slice(i, i + MAX_SEND_BATCH_COUNT));
	}
};

export const createDestinationMessages = (
	config: Config,
	payloads: readonly [EventPayload, ...EventPayload[]],
): Map<string, MessageSendRequest<EventPayload>[]> => {
	const messagesByDestination = new Map<
		string,
		MessageSendRequest<EventPayload>[]
	>();

	for (const payload of payloads) {
		for (const { destination } of findRoutes(config, payload)) {
			const messages = messagesByDestination.get(destination) ?? [];
			messages.push({
				body: payload,
				contentType: "json",
			});
			messagesByDestination.set(destination, messages);
		}
	}

	return messagesByDestination;
};

export const createDeliveryJobs = (
	env: Record<string, unknown>,
	config: Config,
	payloads: readonly [EventPayload, ...EventPayload[]],
): DeliveryJob[] => {
	const messagesByDestination = createDestinationMessages(config, payloads);
	const queuesByDestination = new Map<string, Queue<EventPayload>>();

	for (const destination of messagesByDestination.keys()) {
		queuesByDestination.set(destination, getQueue(env, destination));
	}

	return Array.from(
		messagesByDestination,
		([destination, messages]): DeliveryJob => {
			const queue = queuesByDestination.get(destination);
			if (!queue) {
				throw new Error(`cf-eventhub-v1: ${destination} not resolved`);
			}

			return {
				queue,
				messages,
			};
		},
	);
};

export const deliverJobs = async (
	jobs: readonly DeliveryJob[],
): Promise<void> => {
	for (const { queue, messages } of jobs) {
		await sendBatches(queue, messages);
	}
};
