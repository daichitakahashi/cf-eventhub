import { env } from "cloudflare:workers";
import { EventHub } from ".";
import { routeByConfig, routeFunc } from "./core/routing";
import { configureDelivery } from "./eventhub";
import { QueueMock, R2BucketMock } from "./core/mock";

type Env = {
	OKAYAMA: Queue;
	HOKKAIDO: Queue;
	OKINAWA: Queue;
	ARCHIVE: R2Bucket;
};

export const testRouting = routeByConfig<Env>(env as unknown as Env, {
	routes: [
		{
			condition: {
				path: "$.kind",
				exact: "culture",
			},
			destination: "OKAYAMA",
		},
		{
			condition: {
				path: "$.kind",
				exact: "nature",
			},
			destination: "HOKKAIDO",
		},
		{
			condition: {
				path: "$.kind",
				exact: "nature",
			},
			destination: "OKINAWA",
		},
		{
			condition: {
				path: "$.kind",
				exact: "archive",
			},
			destination: "ARCHIVE",
		},
	],
});

export class TestEventHub extends EventHub<Env> {
	deliveryConfig = configureDelivery({});
	routing = testRouting;
}

type EnvForTestEventHubWithJobId = {
	QUEUE: Queue;
	BUCKET: R2Bucket;
};

export class TestEventHubWithJobId extends EventHub<EnvForTestEventHubWithJobId> {
	deliveryConfig = configureDelivery({ includeDeliveryJobId: true });
	queue = new QueueMock();
	bucket = new R2BucketMock();
	routing = routeFunc<EnvForTestEventHubWithJobId>(
		{
			QUEUE: this.queue,
			BUCKET: this.bucket,
		},
		(e) => {
			const typ = e.type;
			if (typ === "queue")
				return [
					{
						destination: "QUEUE",
					},
				];
			if (typ === "archive")
				return [
					{
						destination: "BUCKET",
					},
				];
			return [];
		},
	);
}

export default {};
