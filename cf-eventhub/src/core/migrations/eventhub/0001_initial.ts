// Creates the durable object storage schema required by the delivery engine.
export const migrateToVersion1 = (sql: SqlStorage): void => {
  sql.exec(`
		CREATE TABLE IF NOT EXISTS payloads (
			id TEXT PRIMARY KEY,
			body TEXT NOT NULL,
			created_at TEXT NOT NULL
		)
	`);
  sql.exec(`
		CREATE TABLE IF NOT EXISTS delivery_jobs (
			id TEXT PRIMARY KEY,
			payload_id TEXT NOT NULL,
			destination TEXT NOT NULL,
			created_at TEXT NOT NULL,
			final_status TEXT CHECK (final_status IN ('completed', 'failed')),
			finalized_at TEXT,
			retry_count INTEGER NOT NULL DEFAULT 0,
			last_failed_at TEXT,
			last_error TEXT,
			next_retry_at TEXT NOT NULL,
			attempt_started_at TEXT,
			lease_expires_at TEXT,
			lease_token TEXT,
			FOREIGN KEY (payload_id) REFERENCES payloads(id)
		)
	`);
  sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_delivery_jobs_payload_id
		ON delivery_jobs (payload_id)
	`);
  sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_payloads_created_at_id
		ON payloads (created_at, id)
	`);
  sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_delivery_jobs_final_status
		ON delivery_jobs (final_status)
	`);
  sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_delivery_jobs_retry_schedule
		ON delivery_jobs (final_status, next_retry_at, created_at, id)
	`);
  sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_delivery_jobs_claim_schedule
		ON delivery_jobs (
			final_status,
			lease_expires_at,
			next_retry_at,
			created_at,
			id
		)
	`);
  sql.exec(`
		CREATE TABLE IF NOT EXISTS ejections (
			key TEXT PRIMARY KEY,
			singleton INTEGER NOT NULL DEFAULT 1 UNIQUE,
			created_at TEXT NOT NULL,
			before_at TEXT NOT NULL
		)
	`);
  sql.exec(`
		CREATE TABLE IF NOT EXISTS ejected_payloads (
			ejection_key TEXT NOT NULL,
			payload_id TEXT NOT NULL,
			body TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (ejection_key, payload_id),
			FOREIGN KEY (ejection_key) REFERENCES ejections(key)
		)
	`);
  sql.exec(`
		CREATE TABLE IF NOT EXISTS ejected_delivery_jobs (
			ejection_key TEXT NOT NULL,
			id TEXT NOT NULL,
			payload_id TEXT NOT NULL,
			destination TEXT NOT NULL,
			created_at TEXT NOT NULL,
			final_status TEXT CHECK (final_status IN ('completed', 'failed')),
			finalized_at TEXT,
			retry_count INTEGER NOT NULL,
			last_failed_at TEXT,
			last_error TEXT,
			next_retry_at TEXT NOT NULL,
			PRIMARY KEY (ejection_key, id),
			FOREIGN KEY (ejection_key) REFERENCES ejections(key)
		)
	`);
  sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_ejected_payloads_ejection_key
		ON ejected_payloads (ejection_key, created_at, payload_id)
	`);
  sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_ejected_delivery_jobs_ejection_key
		ON ejected_delivery_jobs (ejection_key, created_at, id)
	`);
  sql.exec(`
		CREATE TABLE IF NOT EXISTS delivery_job_failures (
			delivery_job_id TEXT PRIMARY KEY,
			reported_at TEXT NOT NULL,
			FOREIGN KEY (delivery_job_id) REFERENCES delivery_jobs(id)
		)
	`);
  sql.exec(`
		CREATE TABLE IF NOT EXISTS ejected_delivery_job_failures (
			ejection_key TEXT NOT NULL,
			delivery_job_id TEXT NOT NULL,
			reported_at TEXT NOT NULL,
			PRIMARY KEY (ejection_key, delivery_job_id),
			FOREIGN KEY (ejection_key) REFERENCES ejections(key)
		)
	`);
  sql.exec(`
		CREATE TABLE IF NOT EXISTS eviction_runs (
			ejection_key TEXT PRIMARY KEY,
			phase TEXT NOT NULL CHECK (phase IN ('pages', 'manifest')),
			cursor TEXT,
			page_index INTEGER NOT NULL,
			payload_count INTEGER NOT NULL,
			archive_prefix TEXT NOT NULL,
			object_id TEXT NOT NULL,
			object_name TEXT,
			cutoff TEXT NOT NULL,
			created_at TEXT NOT NULL,
			completed_at TEXT,
			next_attempt_at TEXT NOT NULL,
			retry_count INTEGER NOT NULL,
			last_error TEXT,
			updated_at TEXT NOT NULL,
			FOREIGN KEY (ejection_key) REFERENCES ejections(key)
		)
	`);
  sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_eviction_runs_next_attempt
		ON eviction_runs (next_attempt_at)
	`);
  sql.exec(`
		CREATE TABLE IF NOT EXISTS automatic_eviction_candidates (
			payload_id TEXT PRIMARY KEY
		) WITHOUT ROWID
	`);
  sql.exec(`
		CREATE TABLE IF NOT EXISTS registry_sync_state (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			synced_at INTEGER NOT NULL
		)
	`);
};
