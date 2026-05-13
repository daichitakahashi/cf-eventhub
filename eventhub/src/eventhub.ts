import { DurableObject } from "cloudflare:workers";

import {
	assertDestinationBindingsExist,
	deliverPersistedJobs,
} from "./core/delivery";
import { MonotonicUlidGenerator } from "./core/id";
import type { Config } from "./core/routing";
import {
	type EjectResult,
	type ListEjectedResult,
	type PersistedDeliveryJob,
	createPendingDeliveryJobs,
	ejectPayloads,
	evictEjection,
	getNextRetryAt,
	initializeSchema,
	listEjected,
	listDeliverableJobs,
	markDeliveryJobsCompleted,
	markDeliveryJobsFailed,
	persistDeliveryJobs,
} from "./core/store";
import type { EventPayload } from "./core/type";

/**
 * Delivery and retry configuration for EventHub.
 */
export type DeliveryConfig = {
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

const MAX_EJECT_PAYLOADS = 100;
const MAX_LIST_EJECTED_PAYLOADS = 100;
const MAX_LIST_EJECTED_BYTES = 262_144;
const DEFAULT_ALARM_BATCH_SIZE = 50;
const DEFAULT_MAX_DELIVERY_RETRIES = 10;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 10_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 900_000;

// Durable object that persists delivery jobs and retries them via alarms.
export class EventHub<
	Env extends Record<string, unknown>,
> extends DurableObject<Env> {
	private readonly idGenerator: MonotonicUlidGenerator;
	private readonly deliveryConfig: DeliveryConfig;

	/**
	 * Override this property to provide routing configuration.
	 * This must return a valid Config object.
	 */
	protected getRouteConfig(): Config {
		throw new Error(
			"eventhub: getRouteConfig() must be implemented in a subclass",
		);
	}

	/**
	 * Override this property to customize delivery retry settings.
	 * All values must be positive integers and adhere to documented limits.
	 */
	protected getDeliveryConfig(): Partial<DeliveryConfig> {
		return {};
	}

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.idGenerator = new MonotonicUlidGenerator();

		const partialDeliveryConfig = this.getDeliveryConfig();
		const deliveryConfig = {
			alarmBatchSize: DEFAULT_ALARM_BATCH_SIZE,
			maxDeliveryRetries: DEFAULT_MAX_DELIVERY_RETRIES,
			initialRetryDelayMs: DEFAULT_INITIAL_RETRY_DELAY_MS,
			maxRetryDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
			...partialDeliveryConfig,
		};
		if (deliveryConfig.alarmBatchSize > 100) {
			throw new Error("eventhub: alarmBatchSize must be <= 100");
		}
		if (deliveryConfig.initialRetryDelayMs > deliveryConfig.maxRetryDelayMs) {
			throw new Error(
				"eventhub: initialRetryDelayMs must be <= maxRetryDelayMs",
			);
		}
		this.deliveryConfig = deliveryConfig;

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

		await deliverPersistedJobs(this.env, targetJobs, {
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
		});
		await this.scheduleNextAlarmFromStorage();
	}

	/**
	 * Persists routed jobs and kicks off their first delivery attempt.
	 * @param payload First payload to publish.
	 * @param rest Additional payloads published in the same batch.
	 */
	async publish(payload: EventPayload, ...rest: EventPayload[]): Promise<void> {
		const routeConfig = this.getRouteConfig();
		const pendingDeliveryJobs = createPendingDeliveryJobs(routeConfig, [
			payload,
			...rest,
		]);
		assertDestinationBindingsExist(this.env, pendingDeliveryJobs);

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
	 * Extracts finalized payloads older than the cutoff into a singleton
	 * ejection snapshot.
	 * @param before Unix time in milliseconds. Finalized payloads older than this
	 * cutoff become ejection candidates.
	 * @param options Optional limits for creating a new ejection snapshot.
	 * `options.max` defaults to `50` and must be an integer in the range
	 * `1..100`.
	 */
	eject(before: number, options?: EjectOptions): EjectResult {
		if (!Number.isFinite(before)) {
			throw new Error("eventhub: before must be a finite number");
		}

		const max = options?.max;
		if (
			max !== undefined &&
			(!Number.isInteger(max) || max <= 0 || max > MAX_EJECT_PAYLOADS)
		) {
			throw new Error(
				`eventhub: max must be a positive integer <= ${MAX_EJECT_PAYLOADS}`,
			);
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
	listEjected(
		ejectKey: string,
		options?: ListEjectedOptions,
	): ListEjectedResult {
		if (ejectKey.length === 0) {
			throw new Error("eventhub: ejectKey must not be empty");
		}

		const max = options?.max;
		if (
			max !== undefined &&
			(!Number.isInteger(max) || max <= 0 || max > MAX_LIST_EJECTED_PAYLOADS)
		) {
			throw new Error(
				`eventhub: max must be a positive integer <= ${MAX_LIST_EJECTED_PAYLOADS}`,
			);
		}

		const maxBytes = options?.maxBytes;
		if (
			maxBytes !== undefined &&
			(!Number.isInteger(maxBytes) ||
				maxBytes <= 0 ||
				maxBytes > MAX_LIST_EJECTED_BYTES)
		) {
			throw new Error(
				`eventhub: maxBytes must be a positive integer <= ${MAX_LIST_EJECTED_BYTES}`,
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
	evict(ejectKey: string): void {
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
}
