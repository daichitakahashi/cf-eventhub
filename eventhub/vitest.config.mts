import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				main: "./src/index.ts",
				miniflare: {
					queueProducers: ["OKAYAMA", "HOKKAIDO", "OKINAWA"],
					r2Buckets: ["ARCHIVE"],
					durableObjects: {
						EVENT_HUB: "TestEventHub",
					},
				},
			},
		},
	},
});
