import type {
	Destinations,
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
) => Map.groupBy(jobs, (j) => j.destination);

// Attaches delivery bindings to persisted jobs before sending them.
export const resolveDeliveryJobs = <Env extends object>(
	routing: RoutingStrategy<Env>,
	jobs: readonly PersistedDeliveryJob[],
): DeliveryJob<Env>[] => {
	const targetsByDestination = new Map<Destinations<Env>, ResolvedDestination>();

	for (const { destination } of jobs) {
		targetsByDestination.set(
			destination as Destinations<Env>,
			routing.resolveDestination(destination as Destinations<Env>),
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

const getR2ObjectKey = (job: PersistedDeliveryJob): string =>
	`${job.payloadId}/${job.id}.json`;

// Merges the delivery job ID into the payload at $.__eventhub__.deliveryJobId
const injectDeliveryJobId = (
	payload: EventPayload,
	jobId: string,
): EventPayload => {
	const existing = payload.__eventhub__;
	const eventhubMetadata =
		typeof existing === "object" &&
		existing !== null &&
		!Array.isArray(existing)
			? { ...existing, deliveryJobId: jobId }
			: { deliveryJobId: jobId };

	return {
		...payload,
		__eventhub__: eventhubMetadata,
	};
};

const deliverQueueJobs = async <Env extends object>(
	jobs: readonly DeliveryJob<Env>[],
	queue: Queue<EventPayload>,
	handlers: DeliverJobsHandlers,
	includeDeliveryJobId: boolean,
): Promise<void> => {
	for (let i = 0; i < jobs.length; i += MAX_SEND_BATCH_COUNT) {
		const chunk = jobs.slice(i, i + MAX_SEND_BATCH_COUNT);
		const jobIds = chunk.map((job) => job.id);
		try {
			await queue.sendBatch(
				chunk.map((job) => ({
					body: includeDeliveryJobId
						? injectDeliveryJobId(job.payload, job.id)
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
	bucket: R2Bucket,
	handlers: DeliverJobsHandlers,
	includeDeliveryJobId: boolean,
): Promise<void> => {
	for (const job of jobs) {
		try {
			const payloadToStore = includeDeliveryJobId
				? injectDeliveryJobId(job.payload, job.id)
				: job.payload;

			await bucket.put(getR2ObjectKey(job), JSON.stringify(payloadToStore), {
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
export const deliverJobs = async <Env extends object>(
	jobs: readonly DeliveryJob<Env>[],
	handlers: DeliverJobsHandlers,
	includeDeliveryJobId: boolean,
): Promise<void> => {
	for (const destinationJobs of groupJobsByDestination(jobs).values()) {
		const [{ target }] = destinationJobs;
		if (target.kind === "queue") {
			await deliverQueueJobs(
				destinationJobs,
				target.queue,
				handlers,
				includeDeliveryJobId,
			);
			continue;
		}
		await deliverR2Jobs(
			destinationJobs,
			target.bucket,
			handlers,
			includeDeliveryJobId,
		);
	}
};

// Resolves queues per destination and keeps other destinations moving on failure.
export const deliverPersistedJobs = async <Env extends object>(
	routing: RoutingStrategy<Env>,
	jobs: readonly PersistedDeliveryJob[],
	handlers: DeliverJobsHandlers,
	includeDeliveryJobId: boolean,
): Promise<void> => {
	for (const destinationJobs of groupJobsByDestination(jobs).values()) {
		try {
			await deliverJobs(
				resolveDeliveryJobs(routing, destinationJobs),
				handlers,
				includeDeliveryJobId,
			);
		} catch (error) {
			await handlers.onFailed(
				destinationJobs.map((job) => job.id),
				error,
			);
		}
	}
};
