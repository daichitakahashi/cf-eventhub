import { DurableObject } from "cloudflare:workers";

import {
	assertDestinationBindingsExist,
	deliverPersistedJobs,
} from "./core/delivery";
import { MonotonicUlidGenerator } from "./core/id";
import type { RoutingStrategy } from "./core/routing";
import {
	type EjectResult,
	type ListOrder,
	type ListResult,
	type ListEjectedResult,
	type PersistedDeliveryJob,
	createPendingDeliveryJobs,
	ejectPayloads,
	evictEjection,
	getNextRetryAt,
	initializeSchema,
	list as listPayloads,
	listEjected,
	listDeliverableJobs,
	markDeliveryJobsCompleted,
	markDeliveryJobsFailed,
	persistDeliveryJobs,
	recordDeliveryJobFailure,
	redriveDeliveryJob,
} from "./core/store";
import type { EventPayload } from "./core/type";

const safe: unique symbol = Symbol();

/**
 * Delivery and retry configuration for EventHub.
 */
export type DeliveryConfig = {
	[safe]: true;

	/**
	 * Maximum number of delivery jobs to process in a single alarm batch.
	 * Must be <= 100.
	 * @default 50
	 */
	alarmBatchSize: number;

	/**
	 * Maximum number of delivery retry attempts before marking a job as failed.
	 * @default 10
	 */
	maxDeliveryRetries: number;

	/**
	 * Initial delay in milliseconds before the first retry attempt.
	 * @default 10000 (10 seconds)
	 */
	initialRetryDelayMs: number;

	/**
	 * Maximum delay in milliseconds between retry attempts.
	 * Retry delays use exponential backoff capped at this value.
	 * Must be >= initialRetryDelayMs.
	 * @default 900000 (15 minutes)
	 */
	maxRetryDelayMs: number;

	/**
	 * Whether to include the delivery job ID in the payload sent to destinations.
	 * When enabled, the job ID is added at path `$.__eventhub__.deliveryJobId`.
	 * @default false
	 */
	includeDeliveryJobId: boolean;
};

export type EjectOptions = {
	/**
	 * Maximum number of payloads to move into a newly created ejection snapshot.
	 * If an active snapshot already exists, that snapshot key is returned as-is.
	 */
	max?: number;
};

export type ListEjectedOptions = {
	/**
	 * Opaque cursor returned by the previous `listEjected()` call.
	 * Omit this field to read the first page.
	 */
	cursor?: string;
	/**
	 * Maximum number of payloads to include in one page.
	 */
	max?: number;
	/**
	 * Soft page budget, in bytes, based on serialized payload bodies.
	 * This limit does not cap the full RPC response size, because delivery job
	 * metadata is added after page selection. The first payload is still returned
	 * when present, even if its body alone exceeds this budget.
	 */
	maxBytes?: number;
};

export type { ListOrder };

export type ListOptions = ListEjectedOptions & {
	/**
	 * Sort direction by event creation time.
	 * Defaults to `"asc"` for backward compatibility.
	 */
	order?: ListOrder;
};

const MAX_EJECT_PAYLOADS = 100;
const MAX_LIST_PAYLOADS = 100;
const MAX_LIST_BYTES = 262_144;
const MAX_LIST_EJECTED_PAYLOADS = 100;
const MAX_LIST_EJECTED_BYTES = 262_144;
const DEFAULT_ALARM_BATCH_SIZE = 50;
const DEFAULT_MAX_DELIVERY_RETRIES = 10;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 10_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 900_000;
const DEFAULT_INCLUDE_DELIVERY_JOB_ID = false;

const assertPositiveInteger = (v: number, name: string) => {
	if (Number.isInteger(v) && v > 0) return;
	throw new Error(`eventhub: ${name} must be a positive integer`);
};

function assertListOrder(v: string): asserts v is ListOrder {
	if (v === "asc" || v === "desc") return;
	throw new Error('eventhub: order must be "asc" or "desc"');
}

/**
 * Configure delivery retry settings and behavior.
 *
 * @example
 * ```ts
 * import { EventHub, configureDelivery } from "eventhub";
 *
 * export class MyEventHub extends EventHub<Env> {
 *   deliveryConfig = configureDelivery({
 *     includeDeliveryJobId: true,  // Enable job ID injection for reportFailure()
 *     initialRetryDelayMs: 5000,   // Start retry after 5 seconds
 *     maxRetryDelayMs: 300000,     // Cap retry delay at 5 minutes
 *     maxDeliveryRetries: 10,      // Retry up to 10 times
 *     alarmBatchSize: 100,         // Process 100 jobs per alarm
 *   });
 * }
 * ```
 */
export const configureDelivery = (
	c: Partial<DeliveryConfig>,
): DeliveryConfig => {
	const cfg = {
		[safe]: true as const,
		alarmBatchSize: DEFAULT_ALARM_BATCH_SIZE,
		maxDeliveryRetries: DEFAULT_MAX_DELIVERY_RETRIES,
		initialRetryDelayMs: DEFAULT_INITIAL_RETRY_DELAY_MS,
		maxRetryDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
		includeDeliveryJobId: DEFAULT_INCLUDE_DELIVERY_JOB_ID,
		...c,
	};

	assertPositiveInteger(cfg.alarmBatchSize, "alarmBatchSize");
	assertPositiveInteger(cfg.maxDeliveryRetries, "maxDeliveryRetries");
	assertPositiveInteger(cfg.initialRetryDelayMs, "initialRetryDelayMs");
	assertPositiveInteger(cfg.maxRetryDelayMs, "maxRetryDelayMs");

	if (cfg.alarmBatchSize > 100)
		throw new Error("eventhub: alarmBatchSize must be <= 100");
	if (cfg.initialRetryDelayMs > cfg.maxRetryDelayMs) {
		throw new Error("eventhub: initialRetryDelayMs must be <= maxRetryDelayMs");
	}

	return cfg;
};

// Durable object that persists delivery jobs and retries them via alarms.
export abstract class EventHub<
	// biome-ignore lint/complexity/noBannedTypes: default
	Env extends Record<string, unknown> = {},
> extends DurableObject<Env> {
	private readonly idGenerator: MonotonicUlidGenerator;
	protected deliveryConfig = configureDelivery({});
	protected abstract routing: RoutingStrategy<Env>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.idGenerator = new MonotonicUlidGenerator();
		initializeSchema(this.ctx.storage.sql);
	}

	// Schedules the next alarm based on the earliest pending retry.
	private async scheduleNextAlarmFromStorage(): Promise<void> {
		const nextRetryAt = this.ctx.storage.transactionSync(() =>
			getNextRetryAt(this.ctx.storage.sql),
		);
		const currentAlarm = await this.ctx.storage.getAlarm();

		if (!nextRetryAt) {
			if (currentAlarm !== null) {
				await this.ctx.storage.deleteAlarm();
			}
			return;
		}

		const nextTime = Date.parse(nextRetryAt);
		if (Number.isNaN(nextTime)) {
			throw new Error("eventhub: invalid next_retry_at");
		}
		if (currentAlarm === null || nextTime !== currentAlarm) {
			await this.ctx.storage.setAlarm(nextTime);
		}
	}

	// Delivers persisted jobs immediately or loads the next due batch from storage.
	private async deliverPersistedJobs(
		jobs?: readonly PersistedDeliveryJob[],
	): Promise<void> {
		const targetJobs =
			jobs ??
			this.ctx.storage.transactionSync(() =>
				listDeliverableJobs(
					this.ctx.storage.sql,
					this.deliveryConfig.alarmBatchSize,
					new Date(),
				),
			);

		if (targetJobs.length === 0) {
			await this.scheduleNextAlarmFromStorage();
			return;
		}

		await deliverPersistedJobs(
			this.routing,
			targetJobs,
			{
				onDelivered: async (jobIds) => {
					this.ctx.storage.transactionSync(() => {
						markDeliveryJobsCompleted(this.ctx.storage.sql, jobIds);
					});
				},
				onFailed: async (jobIds, error) => {
					this.ctx.storage.transactionSync(() => {
						markDeliveryJobsFailed(
							this.ctx.storage.sql,
							jobIds,
							this.deliveryConfig.maxDeliveryRetries,
							this.deliveryConfig.initialRetryDelayMs,
							this.deliveryConfig.maxRetryDelayMs,
							error,
						);
					});
				},
			},
			this.deliveryConfig.includeDeliveryJobId,
		);
		await this.scheduleNextAlarmFromStorage();
	}

	/**
	 * Persists routed jobs and kicks off their first delivery attempt.
	 * @param payload First payload to publish.
	 * @param rest Additional payloads published in the same batch.
	 */
	async publish(payload: EventPayload, ...rest: EventPayload[]): Promise<void> {
		const pendingDeliveryJobs = createPendingDeliveryJobs(this.routing, [
			payload,
			...rest,
		]);
		assertDestinationBindingsExist(this.routing, pendingDeliveryJobs);

		const persistedJobs = this.ctx.storage.transactionSync(() =>
			persistDeliveryJobs(
				this.ctx.storage.sql,
				pendingDeliveryJobs,
				(now) => this.idGenerator.generate(now),
				new Date(),
				this.deliveryConfig.initialRetryDelayMs,
			),
		);
		await this.scheduleNextAlarmFromStorage();
		this.ctx.waitUntil(this.deliverPersistedJobs(persistedJobs));
	}

	/**
	 * Creates a new independent delivery job from an existing job and starts
	 * delivery immediately. The new job stores its own payload row and does not
	 * retain a reference to the original job.
	 * @param deliveryJobId Existing delivery job ID to redrive.
	 * @returns `true` when a new job is created, or `false` when the source job
	 * no longer exists.
	 */
	async redrive(deliveryJobId: string): Promise<boolean> {
		if (deliveryJobId.length === 0) {
			throw new Error("eventhub: deliveryJobId must not be empty");
		}

		const persistedJob = this.ctx.storage.transactionSync(() =>
			redriveDeliveryJob(
				this.ctx.storage.sql,
				deliveryJobId,
				(now) => this.idGenerator.generate(now),
				new Date(),
				this.deliveryConfig.initialRetryDelayMs,
			),
		);
		if (!persistedJob) {
			return false;
		}

		await this.scheduleNextAlarmFromStorage();
		this.ctx.waitUntil(this.deliverPersistedJobs([persistedJob]));
		return true;
	}

	/**
	 * Lists live payloads with bounded page size and payload-body size budget.
	 * @param options Optional pagination settings such as cursor, item count, and
	 * payload-body byte budget. `options.max` defaults to `50` and must be an
	 * integer in the range `1..100`. `options.maxBytes` defaults to `262144`
	 * and must be an integer in the range `1..262144`.
	 */
	async list(options?: ListOptions): Promise<ListResult> {
		const order = options?.order ?? "asc";
		assertListOrder(order);

		const max = options?.max;
		if (max !== undefined) {
			assertPositiveInteger(max, "max");
			if (max > MAX_LIST_PAYLOADS)
				throw new Error(`eventhub: max must be <= ${MAX_LIST_PAYLOADS}`);
		}

		const maxBytes = options?.maxBytes;
		if (maxBytes !== undefined) {
			assertPositiveInteger(maxBytes, "maxBytes");
			if (maxBytes > MAX_LIST_BYTES)
				throw new Error(`eventhub: maxBytes must be <= ${MAX_LIST_BYTES}`);
		}

		return this.ctx.storage.transactionSync(() =>
			listPayloads(
				this.ctx.storage.sql,
				options?.cursor,
				max ?? 50,
				maxBytes ?? MAX_LIST_BYTES,
				order,
			),
		);
	}

	/**
	 * Extracts finalized payloads older than the cutoff into a singleton
	 * ejection snapshot.
	 * @param before Unix time in milliseconds. Finalized payloads older than this
	 * cutoff become ejection candidates.
	 * @param options Optional limits for creating a new ejection snapshot.
	 * `options.max` defaults to `50` and must be an integer in the range
	 * `1..100`.
	 */
	async eject(before: number, options?: EjectOptions): Promise<EjectResult> {
		if (!Number.isFinite(before)) {
			throw new Error("eventhub: before must be a finite number");
		}

		const max = options?.max;
		if (max !== undefined) {
			assertPositiveInteger(max, "max");
			if (max > MAX_EJECT_PAYLOADS)
				throw new Error(`eventhub: max must be <= ${MAX_EJECT_PAYLOADS}`);
		}

		return this.ctx.storage.transactionSync(() =>
			ejectPayloads(
				this.ctx.storage.sql,
				before,
				max ?? 50,
				this.idGenerator.generate(Date.now()),
			),
		);
	}

	/**
	 * Lists payloads from an ejection snapshot with bounded page size and
	 * payload-body size budget.
	 * @param ejectKey Snapshot key returned by `eject()`.
	 * @param options Optional pagination settings such as cursor, item count, and
	 * payload-body byte budget. `options.max` defaults to `50` and must be an
	 * integer in the range `1..100`. `options.maxBytes` defaults to `262144`
	 * and must be an integer in the range `1..262144`.
	 */
	async listEjected(
		ejectKey: string,
		options?: ListEjectedOptions,
	): Promise<ListEjectedResult> {
		if (ejectKey.length === 0) {
			throw new Error("eventhub: ejectKey must not be empty");
		}

		const max = options?.max;
		if (max !== undefined) {
			assertPositiveInteger(max, "max");
			if (max > MAX_LIST_EJECTED_PAYLOADS)
				throw new Error(
					`eventhub: max must be <= ${MAX_LIST_EJECTED_PAYLOADS}`,
				);
		}

		const maxBytes = options?.maxBytes;
		if (maxBytes !== undefined) {
			assertPositiveInteger(maxBytes, "maxBytes");
			if (maxBytes > MAX_LIST_EJECTED_BYTES)
				throw new Error(
					`eventhub: maxBytes must be <= ${MAX_LIST_EJECTED_BYTES}`,
				);
		}

		return this.ctx.storage.transactionSync(() =>
			listEjected(
				this.ctx.storage.sql,
				ejectKey,
				options?.cursor,
				max ?? 50,
				maxBytes ?? MAX_LIST_EJECTED_BYTES,
			),
		);
	}

	/**
	 * Removes a previously ejected snapshot. This operation is idempotent.
	 * @param ejectKey Snapshot key returned by `eject()`.
	 */
	async evict(ejectKey: string): Promise<void> {
		if (ejectKey.length === 0) {
			throw new Error("eventhub: ejectKey must not be empty");
		}

		this.ctx.storage.transactionSync(() => {
			evictEjection(this.ctx.storage.sql, ejectKey);
		});
	}

	/**
	 * Retries delivery for jobs whose retry time has arrived.
	 */
	async alarm(): Promise<void> {
		await this.deliverPersistedJobs();
	}

	/**
	 * Records a consumer-reported failure for a delivery job. This operation is
	 * idempotent: the first call for a given job ID records the failure, and
	 * subsequent calls have no effect.
	 *
	 * **Typical Usage: Dead-Letter Queue Consumer**
	 *
	 * The recommended pattern is to configure a shared DLQ for all EventHub
	 * destination queues and call `reportFailure()` from the DLQ consumer:
	 *
	 * ```ts
	 * // DLQ consumer
	 * export default {
	 *   async queue(batch: MessageBatch, env: Env): Promise<void> {
	 *     const hub = env.EVENT_HUB.get(env.EVENT_HUB.idFromName("default"));
	 *
	 *     for (const message of batch.messages) {
	 *       try {
	 *         await hub.reportFailure(message.body);
	 *         message.ack();
	 *       } catch (error) {
	 *         console.error("Failed to report failure:", error);
	 *         message.retry();
	 *       }
	 *     }
	 *   },
	 * };
	 * ```
	 *
	 * **Prerequisites:**
	 * - Set `includeDeliveryJobId: true` in your `deliveryConfig`
	 * - Configure DLQs for your destination queues in `wrangler.jsonc`
	 *
	 * @param payload The payload that was delivered. Must be an object containing
	 * a delivery job ID at `__eventhub__.deliveryJobId`.
	 * @returns `true` when a new failure record is written, or `false` when no
	 * record is added because the job was already recorded or no longer exists.
	 * @throws {Error} If the payload is not an object or if the delivery job ID
	 * cannot be extracted.
	 */
	async reportFailure(payload: unknown): Promise<boolean> {
		if (
			typeof payload !== "object" ||
			payload === null ||
			Array.isArray(payload)
		) {
			throw new Error("eventhub: payload must be an object");
		}

		const eventhubMetadata = (payload as Record<string, unknown>).__eventhub__;
		if (
			typeof eventhubMetadata !== "object" ||
			eventhubMetadata === null ||
			Array.isArray(eventhubMetadata)
		) {
			throw new Error(
				"eventhub: __eventhub__ metadata not found or invalid in payload",
			);
		}

		const deliveryJobId = (eventhubMetadata as Record<string, unknown>)
			.deliveryJobId;
		if (typeof deliveryJobId !== "string" || deliveryJobId.length === 0) {
			throw new Error("eventhub: deliveryJobId must be a non-empty string");
		}

		return this.ctx.storage.transactionSync(() =>
			recordDeliveryJobFailure(this.ctx.storage.sql, deliveryJobId),
		);
	}
}
