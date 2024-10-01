import type { Config } from "drizzle-kit";

export default {
  dialect: "postgresql",
  schema: "./src/postgres/schema.ts",
  out: "./src/migration/postgres",
} satisfies Config;
