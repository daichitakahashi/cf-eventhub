import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 1000 * 30,
    include: ["**/*.node.test.ts"],
  },
});
