import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
       miniflare: {
        compatibilityDate:"2024-09-23",
        compatibilityFlags : ["nodejs_compat"],
       }
      },
    },
    include: ["**/*.worker.test.ts"],
  },
});
