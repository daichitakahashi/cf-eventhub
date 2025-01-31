import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { Logger } from "../core/logger";
import type { Repository } from "../core/repository";
import { PgRepository } from "./repository";
import * as schema from "./schema";

export function createRepository(
  env: Record<string, unknown>,
  logger: Logger,
): Repository {
  const dsn = getDsn(env.EVENTHUB_DSN);
  if (!dsn) {
    throw new Error(
      "cf-eventhub: EVENTHUB_DSN not set(string or Hyperdrive binding)",
    );
  }
  const pg = postgres(dsn);
  const db = drizzle(pg, { schema });
  return new PgRepository(db, logger);
}

function isHyperdrive(v: unknown): v is Hyperdrive {
  return (
    !!v &&
    typeof v === "object" &&
    "connectionString" in v &&
    typeof v.connectionString === "string"
  );
}

function getDsn(v: unknown): string | undefined {
  if (typeof v === "string") {
    return v;
  }
  if (isHyperdrive(v)) {
    return v.connectionString;
  }
  return undefined;
}
