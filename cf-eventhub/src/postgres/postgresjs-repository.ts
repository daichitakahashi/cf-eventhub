import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { Logger } from "../core/logger";
import type { Repository } from "../core/repository";
import { PgRepository } from "./repository";
import * as schema from "./schema";

export const createRepository = (
  env: Record<string, unknown>,
  logger: Logger,
): Repository => {
  const dsn = env.EVENTHUB_DSN;
  if (typeof dsn !== "string") {
    throw new Error("cf-eventhub: EVENTHUB_DSN not set");
  }
  const pg = postgres(dsn);
  const db = drizzle(pg, { schema });
  return new PgRepository(db, logger);
};
