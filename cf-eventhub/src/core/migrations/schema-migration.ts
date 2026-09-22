type SchemaMigration = (sql: SqlStorage) => void;

// The migration list is ordered by target version: migrations[0] creates v1.
export const migrateSchema = (
  storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
  migrations: readonly SchemaMigration[],
): void => {
  const { sql } = storage;
  const version = storage.transactionSync(() => {
    sql.exec(`
			CREATE TABLE IF NOT EXISTS schema_metadata (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				version INTEGER NOT NULL
			)
		`);
    sql.exec(
      "INSERT OR IGNORE INTO schema_metadata (singleton, version) VALUES (1, 0)",
    );
    return sql
      .exec<{ version: number }>(
        "SELECT version FROM schema_metadata WHERE singleton = 1",
      )
      .one().version;
  });

  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    version > migrations.length
  ) {
    throw new Error(`eventhub: unsupported SQLite schema version ${version}`);
  }

  for (let index = version; index < migrations.length; index++) {
    storage.transactionSync(() => {
      migrations[index](sql);
      sql.exec(
        "UPDATE schema_metadata SET version = ? WHERE singleton = 1",
        index + 1,
      );
    });
  }
};
