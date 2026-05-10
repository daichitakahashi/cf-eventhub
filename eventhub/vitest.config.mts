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
								{
									condition: {
										path: "$.kind",
										exact: "archive",
									},
									destination: "ARCHIVE",
								},
							],
						},
						EVENTHUB_ALARM_BATCH_SIZE: 50,
						EVENTHUB_MAX_DELIVERY_RETRIES: 10,
						EVENTHUB_INITIAL_RETRY_DELAY_MS: 10000,
						EVENTHUB_MAX_RETRY_DELAY_MS: 900000,
					},
					queueProducers: ["OKAYAMA", "HOKKAIDO", "OKINAWA"],
					r2Buckets: ["ARCHIVE"],
				},
			},
		},
	},
});
