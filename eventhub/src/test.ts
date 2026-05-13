import { type Config, EventHub } from ".";

export const routeConfig: Config = {
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
};

export class TestEventHub extends EventHub<Record<string, unknown>> {
	protected getRouteConfig(): Config {
		return routeConfig;
	}
}

export default {};
