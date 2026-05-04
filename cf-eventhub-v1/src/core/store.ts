import { findRoutes, type Config } from "./routing";
import type { EventPayload } from "./type";

export type PendingPayload = {
	payload: EventPayload;
	destinations: string[];
};

export type PendingDeliveryJobs = {
	payloads: PendingPayload[];
};

export type PersistedDeliveryJob = {
	id: number;
	payloadId: number;
	destination: string;
	payload: EventPayload;
};

const insertPayload = (
	sql: SqlStorage,
	payload: EventPayload,
	createdAt: string,
): number => {
	const row = sql
		.exec<{ id: number }>(
			`
				INSERT INTO payloads (body, created_at)
				VALUES (?, ?)
				RETURNING id
			`,
			JSON.stringify(payload),
			createdAt,
		)
		.one();

	return row.id;
};

const insertDeliveryJob = (
	sql: SqlStorage,
	payloadId: number,
	destination: string,
	createdAt: string,
): number => {
	const row = sql
		.exec<{ id: number }>(
			`
				INSERT INTO delivery_jobs (payload_id, destination, created_at, completed_at)
				VALUES (?, ?, ?, NULL)
				RETURNING id
			`,
			payloadId,
			destination,
			createdAt,
		)
		.one();

	return row.id;
};

export const initializeSchema = (sql: SqlStorage): void => {
	sql.exec(`
		CREATE TABLE IF NOT EXISTS payloads (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			body TEXT NOT NULL,
			created_at TEXT NOT NULL
		)
	`);
	sql.exec(`
		CREATE TABLE IF NOT EXISTS delivery_jobs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			payload_id INTEGER NOT NULL,
			destination TEXT NOT NULL,
			created_at TEXT NOT NULL,
			completed_at TEXT,
			FOREIGN KEY (payload_id) REFERENCES payloads(id)
		)
	`);
	sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_delivery_jobs_payload_id
		ON delivery_jobs (payload_id)
	`);
	sql.exec(`
		CREATE INDEX IF NOT EXISTS idx_delivery_jobs_completed_at
		ON delivery_jobs (completed_at)
	`);
};

export const createPendingDeliveryJobs = (
	config: Config,
	payloads: readonly [EventPayload, ...EventPayload[]],
): PendingDeliveryJobs => ({
	payloads: payloads.map((payload) => ({
		payload,
		destinations: findRoutes(config, payload).map(({ destination }) => destination),
	})),
});

export const persistDeliveryJobs = (
	sql: SqlStorage,
	pendingDeliveryJobs: PendingDeliveryJobs,
	now = new Date(),
): PersistedDeliveryJob[] => {
	const createdAt = now.toISOString();
	const jobs: PersistedDeliveryJob[] = [];

	for (const { payload, destinations } of pendingDeliveryJobs.payloads) {
		const payloadId = insertPayload(sql, payload, createdAt);

		for (const destination of destinations) {
			const jobId = insertDeliveryJob(sql, payloadId, destination, createdAt);
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

export const markDeliveryJobsCompleted = (
	sql: SqlStorage,
	jobIds: readonly number[],
	now = new Date(),
): void => {
	if (jobIds.length === 0) {
		return;
	}

	const placeholders = jobIds.map(() => "?").join(", ");
	sql.exec(
		`
			UPDATE delivery_jobs
			SET completed_at = ?
			WHERE id IN (${placeholders})
		`,
		now.toISOString(),
		...jobIds,
	);
};
