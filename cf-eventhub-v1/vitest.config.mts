import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						EVENTHUB_ROUTING: {
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
							],
						},
					},
					queueProducers: ["OKAYAMA", "HOKKAIDO", "OKINAWA"],
				},
			},
		},
	},
});
