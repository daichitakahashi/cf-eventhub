import { EventHub } from ".";
import { routeByConfig } from "./core/routing";
import { configureDelivery } from "./eventhub";

type Env = {
	OKAYAMA: Queue;
	HOKKAIDO: Queue;
	OKINAWA: Queue;
	ARCHIVE: R2Bucket;
};

export const testRouting = routeByConfig<Env>({
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

export class TestEventHubWithJobId extends EventHub<Env> {
	deliveryConfig = configureDelivery({ includeDeliveryJobId: true });
	routing = testRouting;
}

export default {};
