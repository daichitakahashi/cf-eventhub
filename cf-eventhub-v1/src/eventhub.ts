import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";

import {
	assertQueuesExist,
	deliverJobs,
	resolveDeliveryJobs,
} from "./core/queue";
import { MonotonicUlidGenerator } from "./core/id";
import { Config, type ConfigInput } from "./core/routing";
import {
	createPendingDeliveryJobs,
	initializeSchema,
	markDeliveryJobsCompleted,
	persistDeliveryJobs,
} from "./core/store";
import type { EventPayload } from "./core/type";

type EventHubEnv = Record<string, unknown> & {
	EVENTHUB_ROUTING: string | ConfigInput;
};

const getRouteConfig = (env: EventHubEnv) => {
	const routing = env.EVENTHUB_ROUTING;
	if (!routing) {
		throw new Error("cf-eventhub-v1: EVENTHUB_ROUTING not set");
	}

	const maybeConfig =
		typeof routing === "string" ? JSON.parse(routing) : routing;
	return v.parse(Config, maybeConfig);
};

export class EventHub extends DurableObject<EventHubEnv> {
	private readonly idGenerator: MonotonicUlidGenerator;

	constructor(ctx: DurableObjectState, env: EventHubEnv) {
		super(ctx, env);
		this.idGenerator = new MonotonicUlidGenerator();
		initializeSchema(this.ctx.storage.sql);
	}

	async publish(payload: EventPayload, ...rest: EventPayload[]): Promise<void> {
		const routeConfig = getRouteConfig(this.env);
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
			),
		);
		const jobs = resolveDeliveryJobs(this.env, persistedJobs);
		this.ctx.waitUntil(
			deliverJobs(jobs, async (jobIds) => {
				this.ctx.storage.transactionSync(() => {
					markDeliveryJobsCompleted(this.ctx.storage.sql, jobIds);
				});
			}),
		);
	}
}
