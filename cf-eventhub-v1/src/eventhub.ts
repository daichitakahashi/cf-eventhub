import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";

import { createDeliveryJobs, deliverJobs } from "./core/queue";
import { Config, type ConfigInput } from "./core/routing";
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
	private readonly routeConfig: v.InferOutput<typeof Config>;

	constructor(ctx: DurableObjectState, env: EventHubEnv) {
		super(ctx, env);
		this.routeConfig = getRouteConfig(env);
	}

	async publish(payload: EventPayload, ...rest: EventPayload[]): Promise<void> {
		const jobs = createDeliveryJobs(this.env, this.routeConfig, [
			payload,
			...rest,
		]);
		this.ctx.waitUntil(deliverJobs(jobs));
	}
}
