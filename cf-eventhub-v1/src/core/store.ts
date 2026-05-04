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
	id: string;
	payloadId: string;
	destination: string;
	payload: EventPayload;
};

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

const insertDeliveryJob = (
	sql: SqlStorage,
	id: string,
	payloadId: string,
	destination: string,
	createdAt: string,
): void => {
	sql.exec(
		`
			INSERT INTO delivery_jobs (id, payload_id, destination, created_at, completed_at)
			VALUES (?, ?, ?, ?, NULL)
		`,
		id,
		payloadId,
		destination,
		createdAt,
	);
};

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
		destinations: findRoutes(config, payload).map(
			({ destination }) => destination,
		),
	})),
});

export const persistDeliveryJobs = (
	sql: SqlStorage,
	pendingDeliveryJobs: PendingDeliveryJobs,
	generateId: (now: number) => string,
	now = new Date(),
): PersistedDeliveryJob[] => {
	const createdAt = now.toISOString();
	const jobs: PersistedDeliveryJob[] = [];
	const nowMs = now.getTime();

	for (const { payload, destinations } of pendingDeliveryJobs.payloads) {
		const payloadId = generateId(nowMs);
		insertPayload(sql, payloadId, payload, createdAt);

		for (const destination of destinations) {
			const jobId = generateId(nowMs);
			insertDeliveryJob(sql, jobId, payloadId, destination, createdAt);
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
			SET completed_at = ?
			WHERE id IN (${placeholders})
		`,
		now.toISOString(),
		...jobIds,
	);
};
