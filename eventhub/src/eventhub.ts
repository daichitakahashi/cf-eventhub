import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";

import {
	assertDestinationBindingsExist,
	deliverPersistedJobs,
} from "./core/delivery";
import { parsePositiveInteger } from "./core/env";
import { MonotonicUlidGenerator } from "./core/id";
import { Config, type ConfigInput } from "./core/routing";
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

// Environment bindings and tunables required by the durable object.
type EventHubEnv = Record<string, unknown> & {
	EVENTHUB_ROUTING: string | ConfigInput;
	EVENTHUB_ALARM_BATCH_SIZE?: string | number;
	EVENTHUB_MAX_DELIVERY_RETRIES?: string | number;
	EVENTHUB_INITIAL_RETRY_DELAY_MS?: string | number;
	EVENTHUB_MAX_RETRY_DELAY_MS?: string | number;
};

// Parsed delivery settings used by publish and retry flows.
type DeliveryConfig = {
	alarmBatchSize: number;
	maxDeliveryRetries: number;
	initialRetryDelayMs: number;
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

// Parses and validates the routing config binding.
const getRouteConfig = (env: EventHubEnv) => {
	const routing = env.EVENTHUB_ROUTING;
	if (!routing) {
		throw new Error("eventhub: EVENTHUB_ROUTING not set");
	}

	const maybeConfig =
		typeof routing === "string" ? JSON.parse(routing) : routing;
	return v.parse(Config, maybeConfig);
};

// Parses and validates retry-related configuration knobs.
const getDeliveryConfig = (env: EventHubEnv): DeliveryConfig => {
	const alarmBatchSize = parsePositiveInteger(
		env.EVENTHUB_ALARM_BATCH_SIZE,
		DEFAULT_ALARM_BATCH_SIZE,
		"EVENTHUB_ALARM_BATCH_SIZE",
	);
	if (alarmBatchSize > 100) {
		throw new Error("eventhub: EVENTHUB_ALARM_BATCH_SIZE must be <= 100");
	}

	const maxDeliveryRetries = parsePositiveInteger(
		env.EVENTHUB_MAX_DELIVERY_RETRIES,
		DEFAULT_MAX_DELIVERY_RETRIES,
		"EVENTHUB_MAX_DELIVERY_RETRIES",
	);
	const initialRetryDelayMs = parsePositiveInteger(
		env.EVENTHUB_INITIAL_RETRY_DELAY_MS,
		DEFAULT_INITIAL_RETRY_DELAY_MS,
		"EVENTHUB_INITIAL_RETRY_DELAY_MS",
	);
	const maxRetryDelayMs = parsePositiveInteger(
		env.EVENTHUB_MAX_RETRY_DELAY_MS,
		DEFAULT_MAX_RETRY_DELAY_MS,
		"EVENTHUB_MAX_RETRY_DELAY_MS",
	);
	if (initialRetryDelayMs > maxRetryDelayMs) {
		throw new Error(
			"eventhub: EVENTHUB_INITIAL_RETRY_DELAY_MS must be <= EVENTHUB_MAX_RETRY_DELAY_MS",
		);
	}

	return {
		alarmBatchSize,
		maxDeliveryRetries,
		initialRetryDelayMs,
		maxRetryDelayMs,
	};
};

// Durable object that persists delivery jobs and retries them via alarms.
export class EventHub extends DurableObject<EventHubEnv> {
	private readonly idGenerator: MonotonicUlidGenerator;
	private readonly routeConfig: Config;
	private readonly deliveryConfig: DeliveryConfig;

	constructor(ctx: DurableObjectState, env: EventHubEnv) {
		super(ctx, env);
		this.idGenerator = new MonotonicUlidGenerator();
		this.routeConfig = getRouteConfig(env);
		this.deliveryConfig = getDeliveryConfig(env);
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
		const pendingDeliveryJobs = createPendingDeliveryJobs(this.routeConfig, [
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
