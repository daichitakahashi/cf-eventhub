export const migrateToVersion1 = (sql: SqlStorage): void => {
  sql.exec(`
		CREATE TABLE IF NOT EXISTS eventhub_instances (
			name TEXT PRIMARY KEY,
			first_seen_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL,
			deleted_at INTEGER
		)
	`);
  sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_eventhub_instances_last_seen
		ON eventhub_instances (last_seen_at)
	`);
  sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_eventhub_instances_deleted
		ON eventhub_instances (deleted_at)
	`);
};
