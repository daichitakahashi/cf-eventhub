import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      main: "./src/test.ts",
      miniflare: {
        queueProducers: ["OKAYAMA", "HOKKAIDO", "OKINAWA"],
        r2Buckets: ["ARCHIVE", "EVICTION_ARCHIVE"],
      },
    }),
  ],
});
