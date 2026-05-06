import { findRoutes, type Config } from "./routing";
import type { EventPayload } from "./type";

// Raw row shape used when loading persisted jobs with their payload body.
type PersistedDeliveryJobRow = {
	id: string;
	payload_id: string;
	destination: string;
	body: string;
};

// A payload paired with the destinations selected by routing.
export type PendingPayload = {
	payload: EventPayload;
	destinations: string[];
};

// A batch of routed payloads waiting to be persisted.
export type PendingDeliveryJobs = {
	payloads: PendingPayload[];
};

// A persisted job ready to be delivered to a single destination.
export type PersistedDeliveryJob = {
	id: string;
	payloadId: string;
	destination: string;
	payload: EventPayload;
};

export type DeliveryFinalStatus = "completed" | "failed";

// Retry-related fields tracked for each delivery job.
export type DeliveryRetryState = {
	retryCount: number;
	lastFailedAt: string | null;
	lastError: string | null;
	nextRetryAt: string;
	finalStatus: DeliveryFinalStatus | null;
	finalizedAt: string | null;
};

// Full status view used by tests and operational inspection.
export type DeliveryJobStatus = {
	id: string;
	payloadId: string;
	destination: string;
	createdAt: string;
} & DeliveryRetryState;

// Inserts a payload row once before creating per-destination jobs.
const insertPayload = (
	sql: SqlStorage,
	id: string,
	payload: EventPayload,
	createdAt: string,
): void => {
	sql.exec(
		`
			INSERT INTO payloads (id, body, created_at)
			VALUES (?, ?, ?)
		`,
		id,
		JSON.stringify(payload),
		createdAt,
	);
};

// Inserts one delivery job row for a specific destination.
const insertDeliveryJob = (
	sql: SqlStorage,
	id: string,
	payloadId: string,
	destination: string,
	createdAt: string,
	nextRetryAt: string,
): void => {
	sql.exec(
		`
			INSERT INTO delivery_jobs (
				id,
				payload_id,
				destination,
				created_at,
				final_status,
				finalized_at,
				retry_count,
				last_failed_at,
				last_error,
				next_retry_at
			)
			VALUES (?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, ?)
		`,
		id,
		payloadId,
		destination,
		createdAt,
		nextRetryAt,
	);
};

// Creates the durable object storage schema required by the delivery engine.
export const initializeSchema = (sql: SqlStorage): void => {
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
			FOREIGN KEY (payload_id) REFERENCES payloads(id)
		)
	`);
	sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_delivery_jobs_payload_id
		ON delivery_jobs (payload_id)
	`);
	sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_delivery_jobs_final_status
		ON delivery_jobs (final_status)
	`);
	sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_delivery_jobs_retry_schedule
		ON delivery_jobs (final_status, next_retry_at, created_at, id)
	`);
};

// Evaluates routing rules and builds a persistence plan for each payload.
export const createPendingDeliveryJobs = (
	config: Config,
	payloads: readonly [EventPayload, ...EventPayload[]],
): PendingDeliveryJobs => ({
	payloads: payloads.map((payload) => ({
		payload,
		destinations: findRoutes(config, payload).map(
			({ destination }) => destination,
		),
	})),
});

// Persists payloads and delivery jobs and returns the created jobs for dispatch.
export const persistDeliveryJobs = (
	sql: SqlStorage,
	pendingDeliveryJobs: PendingDeliveryJobs,
	generateId: (now: number) => string,
	now = new Date(),
	initialRetryDelayMs = 0,
): PersistedDeliveryJob[] => {
	const createdAt = now.toISOString();
	const nextRetryAt = new Date(
		now.getTime() + initialRetryDelayMs,
	).toISOString();
	const jobs: PersistedDeliveryJob[] = [];
	const nowMs = now.getTime();

	for (const { payload, destinations } of pendingDeliveryJobs.payloads) {
		const payloadId = generateId(nowMs);
		insertPayload(sql, payloadId, payload, createdAt);

		for (const destination of destinations) {
			const jobId = generateId(nowMs);
			insertDeliveryJob(
				sql,
				jobId,
				payloadId,
				destination,
				createdAt,
				nextRetryAt,
			);
			jobs.push({
				id: jobId,
				payloadId,
				destination,
				payload,
			});
		}
	}

	return jobs;
};

// Marks delivered jobs as completed after a successful queue enqueue.
export const markDeliveryJobsCompleted = (
	sql: SqlStorage,
	jobIds: readonly string[],
	now = new Date(),
): void => {
	if (jobIds.length === 0) {
		return;
	}

	const placeholders = jobIds.map(() => "?").join(", ");
	sql.exec(
		`
			UPDATE delivery_jobs
			SET final_status = 'completed',
				finalized_at = ?,
				last_error = NULL
			WHERE id IN (${placeholders})
		`,
		now.toISOString(),
		...jobIds,
	);
};

// Normalizes unknown errors into a string that can be stored.
const toErrorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
};

// Updates retry state after a failed queue enqueue attempt.
export const markDeliveryJobsFailed = (
	sql: SqlStorage,
	jobIds: readonly string[],
	maxRetries: number,
	initialRetryDelayMs: number,
	maxRetryDelayMs: number,
	error: unknown,
	now = new Date(),
): void => {
	if (jobIds.length === 0) {
		return;
	}

	const placeholders = jobIds.map(() => "?").join(", ");
	const failedAt = now.toISOString();
	const rows = sql
		.exec<{ id: string; retry_count: number }>(
			`
				SELECT id, retry_count
				FROM delivery_jobs
				WHERE id IN (${placeholders})
					AND final_status IS NULL
			`,
			...jobIds,
		)
		.toArray();
	const retryCountById = new Map(
		rows.map(({ id, retry_count }) => [id, retry_count + 1]),
	);
	const message = toErrorMessage(error);

	for (const jobId of jobIds) {
		const nextRetryCount = retryCountById.get(jobId);
		if (nextRetryCount === undefined) {
			continue;
		}

		if (nextRetryCount > maxRetries) {
			sql.exec(
				`
					UPDATE delivery_jobs
					SET retry_count = ?,
						last_failed_at = ?,
						last_error = ?,
						final_status = 'failed',
						finalized_at = ?
					WHERE id = ?
				`,
				nextRetryCount,
				failedAt,
				message,
				failedAt,
				jobId,
			);
			continue;
		}

		const delayMs = Math.min(
			initialRetryDelayMs * 2 ** (nextRetryCount - 1),
			maxRetryDelayMs,
		);
		sql.exec(
				`
					UPDATE delivery_jobs
					SET retry_count = ?,
						last_failed_at = ?,
						last_error = ?,
						next_retry_at = ?
					WHERE id = ?
				`,
			nextRetryCount,
			failedAt,
			message,
			new Date(now.getTime() + delayMs).toISOString(),
			jobId,
		);
	}
};

// Lists jobs whose retry schedule allows them to be delivered now.
export const listDeliverableJobs = (
	sql: SqlStorage,
	limit: number,
	now = new Date(),
): PersistedDeliveryJob[] =>
	sql
		.exec<PersistedDeliveryJobRow>(
			`
				SELECT dj.id, dj.payload_id, dj.destination, p.body
				FROM delivery_jobs dj
				INNER JOIN payloads p ON p.id = dj.payload_id
				WHERE dj.final_status IS NULL
					AND dj.next_retry_at <= ?
				ORDER BY dj.next_retry_at ASC, dj.created_at ASC, dj.id ASC
				LIMIT ?
			`,
			now.toISOString(),
			limit,
		)
		.toArray()
		.map((row) => ({
			id: row.id,
			payloadId: row.payload_id,
			destination: row.destination,
			payload: JSON.parse(row.body) as EventPayload,
		}));

// Returns the earliest retry timestamp among active jobs.
export const getNextRetryAt = (sql: SqlStorage): string | null => {
	const row = sql
		.exec<{ next_retry_at: string }>(
			`
				SELECT next_retry_at
				FROM delivery_jobs
				WHERE final_status IS NULL
				ORDER BY next_retry_at ASC, created_at ASC, id ASC
				LIMIT 1
			`,
		)
		.toArray()[0];
	return row?.next_retry_at ?? null;
};

// Returns the full job table in a test- and ops-friendly shape.
export const listDeliveryJobStatuses = (sql: SqlStorage): DeliveryJobStatus[] =>
	sql
		.exec<{
			id: string;
			payload_id: string;
			destination: string;
			created_at: string;
			final_status: DeliveryFinalStatus | null;
			finalized_at: string | null;
			retry_count: number;
			last_failed_at: string | null;
			last_error: string | null;
			next_retry_at: string;
		}>(
			`
				SELECT
					id,
					payload_id,
					destination,
					created_at,
					final_status,
					finalized_at,
					retry_count,
					last_failed_at,
					last_error,
					next_retry_at
				FROM delivery_jobs
				ORDER BY id
			`,
		)
		.toArray()
		.map((row) => ({
			id: row.id,
			payloadId: row.payload_id,
			destination: row.destination,
			createdAt: row.created_at,
			finalStatus: row.final_status,
			finalizedAt: row.finalized_at,
			retryCount: row.retry_count,
			lastFailedAt: row.last_failed_at,
			lastError: row.last_error,
			nextRetryAt: row.next_retry_at,
		}));
