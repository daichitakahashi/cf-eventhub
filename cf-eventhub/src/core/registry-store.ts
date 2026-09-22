import { migrateToVersion1 } from "./migrations/registry/0001_initial";
import { migrateSchema } from "./migrations/schema-migration";

export type RegistryInstanceStatus = "active" | "stale" | "deleted";

export type RegistryInstance = {
  name: string;
  firstSeenAt: string;
  lastSeenAt: string;
  deletedAt: string | null;
  status: RegistryInstanceStatus;
};

type RegistryInstanceRow = {
  name: string;
  first_seen_at: number;
  last_seen_at: number;
  deleted_at: number | null;
};

export const initializeRegistrySchema = (
  storage: DurableObjectStorage,
): void => {
  migrateSchema(storage, [migrateToVersion1], "eventhub registry");
};

const getStatus = (
  row: RegistryInstanceRow,
  staleCutoff: number,
): RegistryInstanceStatus => {
  if (row.deleted_at !== null) return "deleted";
  return row.last_seen_at < staleCutoff ? "stale" : "active";
};

const toInstance = (
  row: RegistryInstanceRow,
  staleCutoff: number,
): RegistryInstance => ({
  name: row.name,
  firstSeenAt: new Date(row.first_seen_at).toISOString(),
  lastSeenAt: new Date(row.last_seen_at).toISOString(),
  deletedAt:
    row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
  status: getStatus(row, staleCutoff),
});

export const registerInstance = (
  sql: SqlStorage,
  name: string,
  now: number,
  staleCutoff: number,
): RegistryInstance => {
  const row = sql
    .exec<RegistryInstanceRow>(
      `
			INSERT INTO eventhub_instances (
				name, first_seen_at, last_seen_at, deleted_at
			) VALUES (?, ?, ?, NULL)
			ON CONFLICT(name) DO UPDATE SET
				last_seen_at = excluded.last_seen_at,
				deleted_at = NULL
			RETURNING name, first_seen_at, last_seen_at, deleted_at
		`,
      name,
      now,
      now,
    )
    .one();
  return toInstance(row, staleCutoff);
};

export const getInstance = (
  sql: SqlStorage,
  name: string,
  staleCutoff: number,
): RegistryInstance | null => {
  const row = sql
    .exec<RegistryInstanceRow>(
      `
			SELECT name, first_seen_at, last_seen_at, deleted_at
			FROM eventhub_instances
			WHERE name = ?
		`,
      name,
    )
    .toArray()[0];
  return row ? toInstance(row, staleCutoff) : null;
};

export const listInstances = (
  sql: SqlStorage,
  status: RegistryInstanceStatus,
  cursorName: string | undefined,
  max: number,
  staleCutoff: number,
  nameContains?: string,
): { instances: RegistryInstance[]; nextName?: string } => {
  const predicate =
    status === "deleted"
      ? "deleted_at IS NOT NULL"
      : status === "stale"
        ? "deleted_at IS NULL AND last_seen_at < ?"
        : "deleted_at IS NULL AND last_seen_at >= ?";
  const bindings: (string | number)[] = [];
  if (status !== "deleted") bindings.push(staleCutoff);
  if (nameContains) bindings.push(nameContains);
  if (cursorName !== undefined) bindings.push(cursorName);
  bindings.push(max + 1);

  const rows = sql
    .exec<RegistryInstanceRow>(
      `
			SELECT name, first_seen_at, last_seen_at, deleted_at
			FROM eventhub_instances
			WHERE ${predicate}
			${nameContains ? "AND instr(name, ?) > 0" : ""}
			${cursorName === undefined ? "" : "AND name > ?"}
			ORDER BY name ASC
			LIMIT ?
		`,
      ...bindings,
    )
    .toArray();
  const hasMore = rows.length > max;
  const page = rows.slice(0, max);
  return {
    instances: page.map((row) => toInstance(row, staleCutoff)),
    ...(hasMore ? { nextName: page[page.length - 1]?.name } : {}),
  };
};

export const tombstoneInstance = (
  sql: SqlStorage,
  name: string,
  now: number,
): boolean => {
  const rows = sql
    .exec<{ name: string }>(
      `
			UPDATE eventhub_instances
			SET deleted_at = COALESCE(deleted_at, ?)
			WHERE name = ?
			RETURNING name
		`,
      now,
      name,
    )
    .toArray();
  return rows.length > 0;
};
