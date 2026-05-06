import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";

import { MonotonicUlidGenerator } from "./core/id";
import { assertQueuesExist, deliverPersistedJobs } from "./core/queue";
import { Config, type ConfigInput } from "./core/routing";
import {
	type PersistedDeliveryJob,
	createPendingDeliveryJobs,
	getNextRetryAt,
	initializeSchema,
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

const DEFAULT_ALARM_BATCH_SIZE = 50;
const DEFAULT_MAX_DELIVERY_RETRIES = 10;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 10_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 900_000;

// Parses and validates the routing config binding.
const getRouteConfig = (env: EventHubEnv) => {
	const routing = env.EVENTHUB_ROUTING;
	if (!routing) {
		throw new Error("cf-eventhub-v1: EVENTHUB_ROUTING not set");
	}

	const maybeConfig =
		typeof routing === "string" ? JSON.parse(routing) : routing;
	return v.parse(Config, maybeConfig);
};

// Parses a positive integer env var with a fallback value.
const parsePositiveInteger = (
	value: string | number | undefined,
	fallback: number,
	name: string,
): number => {
	if (value === undefined) {
		return fallback;
	}

	const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`cf-eventhub-v1: invalid ${name}`);
	}
	return parsed;
};

// Parses and validates retry-related configuration knobs.
const getDeliveryConfig = (env: EventHubEnv): DeliveryConfig => {
	const alarmBatchSize = parsePositiveInteger(
		env.EVENTHUB_ALARM_BATCH_SIZE,
		DEFAULT_ALARM_BATCH_SIZE,
		"EVENTHUB_ALARM_BATCH_SIZE",
	);
	if (alarmBatchSize > 100) {
		throw new Error("cf-eventhub-v1: EVENTHUB_ALARM_BATCH_SIZE must be <= 100");
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
			"cf-eventhub-v1: EVENTHUB_INITIAL_RETRY_DELAY_MS must be <= EVENTHUB_MAX_RETRY_DELAY_MS",
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

	constructor(ctx: DurableObjectState, env: EventHubEnv) {
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
			throw new Error("cf-eventhub-v1: invalid next_retry_at");
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
					getDeliveryConfig(this.env).alarmBatchSize,
					new Date(),
				),
			);

		if (targetJobs.length === 0) {
			await this.scheduleNextAlarmFromStorage();
			return;
		}

		const config = getDeliveryConfig(this.env);
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
						config.maxDeliveryRetries,
						config.initialRetryDelayMs,
						config.maxRetryDelayMs,
						error,
					);
				});
			},
		});
		await this.scheduleNextAlarmFromStorage();
	}

	// Persists routed jobs and kicks off their first delivery attempt.
	async publish(payload: EventPayload, ...rest: EventPayload[]): Promise<void> {
		const routeConfig = getRouteConfig(this.env);
		const deliveryConfig = getDeliveryConfig(this.env);
		const pendingDeliveryJobs = createPendingDeliveryJobs(routeConfig, [
			payload,
			...rest,
		]);
		assertQueuesExist(this.env, pendingDeliveryJobs);

		const persistedJobs = this.ctx.storage.transactionSync(() =>
			persistDeliveryJobs(
				this.ctx.storage.sql,
				pendingDeliveryJobs,
				(now) => this.idGenerator.generate(now),
				new Date(),
				deliveryConfig.initialRetryDelayMs,
			),
		);
		await this.scheduleNextAlarmFromStorage();
		this.ctx.waitUntil(this.deliverPersistedJobs(persistedJobs));
	}

	// Retries delivery for jobs whose retry time has arrived.
	async alarm(): Promise<void> {
		await this.deliverPersistedJobs();
	}
}
