import type { RoutingStrategy } from "./routing";
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

export type ListedDeliveryJob = DeliveryJobStatus & {
  failureReportedAt: string | null;
};

export type ListedPayload = {
  payload: EventPayload;
  deliveryJobs: ListedDeliveryJob[];
};

export type ListOrder = "asc" | "desc";

export type EjectResult =
  | {
      ejectKey: null;
    }
  | {
      ejectKey: string;
    };

export type ListResult = {
  cursor?: string;
  payloads: ListedPayload[];
};

export type EjectedDeliveryJob = ListedDeliveryJob;
export type EjectedPayload = ListedPayload;
export type ListEjectedResult = ListResult;

export type EvictionRunPhase = "pages" | "manifest";

export type EvictionRun = {
  ejectionKey: string;
  phase: EvictionRunPhase;
  cursor: string | null;
  pageIndex: number;
  payloadCount: number;
  archivePrefix: string;
  objectId: string;
  objectName: string | null;
  cutoff: string;
  createdAt: string;
  completedAt: string | null;
  nextAttemptAt: string;
  retryCount: number;
  lastError: string | null;
  updatedAt: string;
};

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
};

// Evaluates routing rules and builds a persistence plan for each payload.
export const createPendingDeliveryJobs = <Env extends object>(
  routing: RoutingStrategy<Env>,
  payloads: readonly [EventPayload, ...EventPayload[]],
): PendingDeliveryJobs => ({
  payloads: payloads.map((payload) => ({
    payload,
    destinations: routing
      .findRoutes(payload)
      .map(({ destination }) => String(destination)),
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

// Creates a new independent payload and delivery job from an existing job.
export const redriveDeliveryJob = (
  sql: SqlStorage,
  deliveryJobId: string,
  generateId: (now: number) => string,
  now = new Date(),
  initialRetryDelayMs = 0,
): PersistedDeliveryJob | null => {
  const row = sql
    .exec<PersistedDeliveryJobRow>(
      `
				SELECT dj.id, dj.payload_id, dj.destination, p.body
				FROM delivery_jobs dj
				INNER JOIN payloads p ON p.id = dj.payload_id
				WHERE dj.id = ?
			`,
      deliveryJobId,
    )
    .toArray()[0];
  if (!row) {
    return null;
  }

  const payload = JSON.parse(row.body) as EventPayload;
  const nowMs = now.getTime();
  const createdAt = now.toISOString();
  const nextRetryAt = new Date(nowMs + initialRetryDelayMs).toISOString();
  const payloadId = generateId(nowMs);
  const jobId = generateId(nowMs);

  insertPayload(sql, payloadId, payload, createdAt);
  insertDeliveryJob(
    sql,
    jobId,
    payloadId,
    row.destination,
    createdAt,
    nextRetryAt,
  );

  return {
    id: jobId,
    payloadId,
    destination: row.destination,
    payload,
  };
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
				AND (final_status IS NULL OR final_status = 'failed')
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

const encodeCursor = (createdAt: string, payloadId: string): string =>
  btoa(JSON.stringify([createdAt, payloadId]));

const decodeCursor = (
  cursor: string,
): { createdAt: string; payloadId: string } => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(atob(cursor)) as unknown;
  } catch {
    throw new Error("eventhub: invalid cursor");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    typeof decoded[1] !== "string"
  ) {
    throw new Error("eventhub: invalid cursor");
  }
  return {
    createdAt: decoded[0],
    payloadId: decoded[1],
  };
};

const groupBy = <T, K>(
  items: readonly T[],
  getKey: (item: T) => K,
): Map<K, T[]> => {
  const grouped = new Map<K, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const group = grouped.get(key);
    if (group) {
      group.push(item);
    } else {
      grouped.set(key, [item]);
    }
  }
  return grouped;
};

type EjectedPayloadRow = {
  payload_id: string;
  body: string;
  created_at: string;
  body_bytes: number;
};

type PayloadPageRow = {
  payload_id: string;
  body: string;
  created_at: string;
  body_bytes: number;
};

const listPayloadRows = (
  sql: SqlStorage,
  cursor: string | undefined,
  limit: number,
  maxBytes: number,
  order: ListOrder,
): PayloadPageRow[] => {
  const orderSql = order === "asc" ? "ASC" : "DESC";
  const nextCondition =
    order === "asc"
      ? `
				p2.created_at > page.created_at
				OR (
					p2.created_at = page.created_at
					AND p2.id > page.payload_id
				)
			`
      : `
				p2.created_at < page.created_at
				OR (
					p2.created_at = page.created_at
					AND p2.id < page.payload_id
				)
			`;
  const cursorCondition =
    order === "asc"
      ? `
				p.created_at > ?3
				OR (p.created_at = ?3 AND p.id > ?4)
			`
      : `
				p.created_at < ?3
				OR (p.created_at = ?3 AND p.id < ?4)
			`;

  if (cursor === undefined) {
    return sql
      .exec<PayloadPageRow>(
        `
					WITH RECURSIVE
					first_row AS (
						SELECT
							p.id AS payload_id,
							p.body,
							p.created_at,
							octet_length(p.body) AS body_bytes
						FROM payloads p
						ORDER BY p.created_at ${orderSql}, p.id ${orderSql}
						LIMIT 1
					),
					page(
						payload_id,
						body,
						created_at,
						body_bytes,
						total_bytes,
						row_count
					) AS (
						SELECT
							fr.payload_id,
							fr.body,
							fr.created_at,
							fr.body_bytes,
							fr.body_bytes AS total_bytes,
							1 AS row_count
						FROM first_row fr

						UNION ALL

						SELECT
							p.id AS payload_id,
							p.body,
							p.created_at,
							octet_length(p.body) AS body_bytes,
							page.total_bytes + octet_length(p.body) AS total_bytes,
							page.row_count + 1 AS row_count
						FROM page
						JOIN payloads p
							ON p.id = (
								SELECT p2.id
								FROM payloads p2
								WHERE ${nextCondition}
								ORDER BY p2.created_at ${orderSql}, p2.id ${orderSql}
								LIMIT 1
							)
						WHERE page.row_count < ?1
							AND page.total_bytes + octet_length(p.body) <= ?2
					)
					SELECT
						payload_id,
						body,
						created_at,
						body_bytes
					FROM page
					ORDER BY created_at ${orderSql}, payload_id ${orderSql}
				`,
        limit,
        maxBytes,
      )
      .toArray();
  }

  const { createdAt, payloadId } = decodeCursor(cursor);
  return sql
    .exec<PayloadPageRow>(
      `
				WITH RECURSIVE
				first_row AS (
					SELECT
						p.id AS payload_id,
						p.body,
						p.created_at,
						octet_length(p.body) AS body_bytes
					FROM payloads p
					WHERE ${cursorCondition}
					ORDER BY p.created_at ${orderSql}, p.id ${orderSql}
					LIMIT 1
				),
				page(
					payload_id,
					body,
					created_at,
					body_bytes,
					total_bytes,
					row_count
				) AS (
					SELECT
						fr.payload_id,
						fr.body,
						fr.created_at,
						fr.body_bytes,
						fr.body_bytes AS total_bytes,
						1 AS row_count
					FROM first_row fr

					UNION ALL

					SELECT
						p.id AS payload_id,
						p.body,
						p.created_at,
						octet_length(p.body) AS body_bytes,
						page.total_bytes + octet_length(p.body) AS total_bytes,
						page.row_count + 1 AS row_count
					FROM page
					JOIN payloads p
						ON p.id = (
							SELECT p2.id
							FROM payloads p2
							WHERE ${nextCondition}
							ORDER BY p2.created_at ${orderSql}, p2.id ${orderSql}
							LIMIT 1
						)
					WHERE page.row_count < ?1
						AND page.total_bytes + octet_length(p.body) <= ?2
				)
				SELECT
					payload_id,
					body,
					created_at,
					body_bytes
				FROM page
				ORDER BY created_at ${orderSql}, payload_id ${orderSql}
			`,
      limit,
      maxBytes,
      createdAt,
      payloadId,
    )
    .toArray();
};

export const list = (
  sql: SqlStorage,
  cursor?: string,
  max = 50,
  maxBytes = 262_144, // 256KiB
  order: ListOrder = "asc",
): ListResult => {
  const payloadRows = listPayloadRows(sql, cursor, max, maxBytes, order);
  if (payloadRows.length === 0) {
    return { payloads: [] };
  }

  const payloadIds = payloadRows.map(({ payload_id }) => payload_id);
  const deliveryJobs = sql
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
      failure_reported_at: string | null;
    }>(
      `
				SELECT
					dj.id,
					dj.payload_id,
					dj.destination,
					dj.created_at,
					dj.final_status,
					dj.finalized_at,
					dj.retry_count,
					dj.last_failed_at,
					dj.last_error,
					dj.next_retry_at,
					djf.reported_at AS failure_reported_at
				FROM delivery_jobs dj
				LEFT JOIN delivery_job_failures djf
					ON djf.delivery_job_id = dj.id
				WHERE dj.payload_id IN (SELECT value FROM json_each(?))
				ORDER BY dj.created_at ASC, dj.id ASC
			`,
      JSON.stringify(payloadIds),
    )
    .toArray()
    .map(
      (row): ListedDeliveryJob => ({
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
        failureReportedAt: row.failure_reported_at,
      }),
    );
  const jobsByPayloadId = groupBy(deliveryJobs, (job) => job.payloadId);
  const lastRow = payloadRows[payloadRows.length - 1];
  const hasMoreCondition =
    order === "asc"
      ? `
				p.created_at > ?1
				OR (p.created_at = ?1 AND p.id > ?2)
			`
      : `
				p.created_at < ?1
				OR (p.created_at = ?1 AND p.id < ?2)
			`;
  const orderSql = order === "asc" ? "ASC" : "DESC";
  const hasMore =
    sql
      .exec<{ payload_id: string }>(
        `
					SELECT p.id AS payload_id
					FROM payloads p
					WHERE ${hasMoreCondition}
					ORDER BY p.created_at ${orderSql}, p.id ${orderSql}
					LIMIT 1
				`,
        lastRow.created_at,
        lastRow.payload_id,
      )
      .toArray().length > 0;

  return {
    cursor: hasMore
      ? encodeCursor(lastRow.created_at, lastRow.payload_id)
      : undefined,
    payloads: payloadRows.map(({ payload_id, body }) => ({
      payload: JSON.parse(body) as EventPayload,
      deliveryJobs: jobsByPayloadId.get(payload_id) ?? [],
    })),
  };
};

const listEjectedPayloadRows = (
  sql: SqlStorage,
  ejectionKey: string,
  cursor: string | undefined,
  limit: number,
  maxBytes: number,
): EjectedPayloadRow[] => {
  if (cursor === undefined) {
    return sql
      .exec<EjectedPayloadRow>(
        `
					WITH RECURSIVE
					first_row AS (
						SELECT
							ep.payload_id,
							ep.body,
							ep.created_at,
							octet_length(ep.body) AS body_bytes
						FROM ejected_payloads ep
						WHERE ep.ejection_key = ?1
						ORDER BY ep.created_at ASC, ep.payload_id ASC
						LIMIT 1
					),
					page(
						payload_id,
						body,
						created_at,
						body_bytes,
						total_bytes,
						row_count
					) AS (
						SELECT
							fr.payload_id,
							fr.body,
							fr.created_at,
							fr.body_bytes,
							fr.body_bytes AS total_bytes,
							1 AS row_count
						FROM first_row fr

						UNION ALL

						SELECT
							ep.payload_id,
							ep.body,
							ep.created_at,
							octet_length(ep.body) AS body_bytes,
							page.total_bytes + octet_length(ep.body) AS total_bytes,
							page.row_count + 1 AS row_count
						FROM page
						JOIN ejected_payloads ep
							ON ep.ejection_key = ?1
							AND ep.payload_id = (
								SELECT ep2.payload_id
								FROM ejected_payloads ep2
								WHERE ep2.ejection_key = ?1
									AND (
										ep2.created_at > page.created_at
										OR (
											ep2.created_at = page.created_at
											AND ep2.payload_id > page.payload_id
										)
									)
								ORDER BY ep2.created_at ASC, ep2.payload_id ASC
								LIMIT 1
							)
						WHERE page.row_count < ?2
							AND page.total_bytes + octet_length(ep.body) <= ?3
					)
					SELECT
						payload_id,
						body,
						created_at,
						body_bytes
					FROM page
					ORDER BY created_at ASC, payload_id ASC
				`,
        ejectionKey,
        limit,
        maxBytes,
      )
      .toArray();
  }

  const { createdAt, payloadId } = decodeCursor(cursor);
  return sql
    .exec<EjectedPayloadRow>(
      `
				WITH RECURSIVE
				first_row AS (
					SELECT
						ep.payload_id,
						ep.body,
						ep.created_at,
						octet_length(ep.body) AS body_bytes
					FROM ejected_payloads ep
					WHERE ep.ejection_key = ?1
						AND (
							ep.created_at > ?4
							OR (ep.created_at = ?4 AND ep.payload_id > ?5)
						)
					ORDER BY ep.created_at ASC, ep.payload_id ASC
					LIMIT 1
				),
				page(
					payload_id,
					body,
					created_at,
					body_bytes,
					total_bytes,
					row_count
				) AS (
					SELECT
						fr.payload_id,
						fr.body,
						fr.created_at,
						fr.body_bytes,
						fr.body_bytes AS total_bytes,
						1 AS row_count
					FROM first_row fr

					UNION ALL

					SELECT
						ep.payload_id,
						ep.body,
						ep.created_at,
						octet_length(ep.body) AS body_bytes,
						page.total_bytes + octet_length(ep.body) AS total_bytes,
						page.row_count + 1 AS row_count
					FROM page
					JOIN ejected_payloads ep
						ON ep.ejection_key = ?1
						AND ep.payload_id = (
							SELECT ep2.payload_id
							FROM ejected_payloads ep2
							WHERE ep2.ejection_key = ?1
								AND (
									ep2.created_at > page.created_at
									OR (
										ep2.created_at = page.created_at
										AND ep2.payload_id > page.payload_id
									)
								)
							ORDER BY ep2.created_at ASC, ep2.payload_id ASC
							LIMIT 1
						)
					WHERE page.row_count < ?2
						AND page.total_bytes + octet_length(ep.body) <= ?3
				)
				SELECT
					payload_id,
					body,
					created_at,
					body_bytes
				FROM page
				ORDER BY created_at ASC, payload_id ASC
			`,
      ejectionKey,
      limit,
      maxBytes,
      createdAt,
      payloadId,
    )
    .toArray();
};

export const listEjected = (
  sql: SqlStorage,
  ejectionKey: string,
  cursor?: string,
  max = 50,
  maxBytes = 262_144, // 256KiB
): ListEjectedResult => {
  const payloadRows = listEjectedPayloadRows(
    sql,
    ejectionKey,
    cursor,
    max,
    maxBytes,
  );
  if (payloadRows.length === 0) {
    return { payloads: [] };
  }

  const payloadIds = payloadRows.map(({ payload_id }) => payload_id);
  const deliveryJobs = sql
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
      failure_reported_at: string | null;
    }>(
      `
				SELECT
					edj.id,
					edj.payload_id,
					edj.destination,
					edj.created_at,
					edj.final_status,
					edj.finalized_at,
					edj.retry_count,
					edj.last_failed_at,
					edj.last_error,
					edj.next_retry_at,
					edjf.reported_at AS failure_reported_at
				FROM ejected_delivery_jobs edj
				LEFT JOIN ejected_delivery_job_failures edjf
					ON edjf.ejection_key = edj.ejection_key
					AND edjf.delivery_job_id = edj.id
				WHERE edj.ejection_key = ?
					AND edj.payload_id IN (SELECT value FROM json_each(?))
				ORDER BY edj.created_at ASC, edj.id ASC
			`,
      ejectionKey,
      JSON.stringify(payloadIds),
    )
    .toArray()
    .map(
      (row): EjectedDeliveryJob => ({
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
        failureReportedAt: row.failure_reported_at,
      }),
    );
  const jobsByPayloadId = groupBy(deliveryJobs, (job) => job.payloadId);
  const lastRow = payloadRows[payloadRows.length - 1];
  const hasMore =
    sql
      .exec<{ payload_id: string }>(
        `
					SELECT ep.payload_id
					FROM ejected_payloads ep
					WHERE ep.ejection_key = ?1
						AND (
							ep.created_at > ?2
							OR (ep.created_at = ?2 AND ep.payload_id > ?3)
						)
					ORDER BY ep.created_at ASC, ep.payload_id ASC
					LIMIT 1
				`,
        ejectionKey,
        lastRow.created_at,
        lastRow.payload_id,
      )
      .toArray().length > 0;

  return {
    cursor: hasMore
      ? encodeCursor(lastRow.created_at, lastRow.payload_id)
      : undefined,
    payloads: payloadRows.map(({ payload_id, body }) => ({
      payload: JSON.parse(body) as EventPayload,
      deliveryJobs: jobsByPayloadId.get(payload_id) ?? [],
    })),
  };
};

export const ejectPayloads = (
  sql: SqlStorage,
  before: number,
  max: number,
  ejectKey: string,
  now = new Date(),
): EjectResult => {
  const activeEjection = sql
    .exec<{ key: string }>(
      `
				SELECT key
				FROM ejections
				LIMIT 1
			`,
    )
    .toArray()[0];
  if (activeEjection) {
    return {
      ejectKey: activeEjection.key,
    };
  }

  const beforeIso = new Date(before).toISOString();
  sql.exec(
    `
			INSERT INTO ejections (key, created_at, before_at)
			VALUES (?, ?, ?)
		`,
    ejectKey,
    now.toISOString(),
    beforeIso,
  );
  sql.exec(
    `
			INSERT INTO ejected_payloads (ejection_key, payload_id, body, created_at)
			SELECT ?, p.id, p.body, p.created_at
			FROM (
				SELECT p.id
				FROM payloads p
				LEFT JOIN delivery_jobs dj ON dj.payload_id = p.id
				GROUP BY p.id
				HAVING (COUNT(dj.id) = 0 AND p.created_at < ?)
					OR (
						COUNT(dj.id) > 0
						AND SUM(CASE WHEN dj.final_status IS NULL THEN 1 ELSE 0 END) = 0
						AND MAX(dj.finalized_at) < ?
					)
				ORDER BY CASE
					WHEN COUNT(dj.id) = 0 THEN p.created_at
					ELSE MAX(dj.finalized_at)
				END ASC, p.id ASC
				LIMIT ?
			) candidates
			INNER JOIN payloads p ON p.id = candidates.id
		`,
    ejectKey,
    beforeIso,
    beforeIso,
    max,
  );
  const candidateCount = sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM ejected_payloads WHERE ejection_key = ?",
      ejectKey,
    )
    .one().count;
  if (candidateCount === 0) {
    sql.exec("DELETE FROM ejections WHERE key = ?", ejectKey);
    return { ejectKey: null };
  }
  sql.exec(
    `
			INSERT INTO ejected_delivery_jobs (
				ejection_key,
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
			SELECT
				?,
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
			WHERE payload_id IN (
				SELECT payload_id FROM ejected_payloads WHERE ejection_key = ?
			)
		`,
    ejectKey,
    ejectKey,
  );
  sql.exec(
    `
			INSERT INTO ejected_delivery_job_failures (
				ejection_key,
				delivery_job_id,
				reported_at
			)
			SELECT
				?,
				djf.delivery_job_id,
				djf.reported_at
			FROM delivery_job_failures djf
			INNER JOIN delivery_jobs dj ON dj.id = djf.delivery_job_id
			WHERE dj.payload_id IN (
				SELECT payload_id FROM ejected_payloads WHERE ejection_key = ?
			)
		`,
    ejectKey,
    ejectKey,
  );

  sql.exec(
    `
			DELETE FROM delivery_job_failures
			WHERE delivery_job_id IN (
				SELECT id FROM delivery_jobs
				WHERE payload_id IN (
					SELECT payload_id FROM ejected_payloads WHERE ejection_key = ?
				)
			)
		`,
    ejectKey,
  );
  sql.exec(
    `
      DELETE FROM delivery_jobs
      WHERE payload_id IN (
        SELECT payload_id FROM ejected_payloads WHERE ejection_key = ?
      )
    `,
    ejectKey,
  );
  sql.exec(
    `
      DELETE FROM payloads
      WHERE id IN (
        SELECT payload_id FROM ejected_payloads WHERE ejection_key = ?
      )
    `,
    ejectKey,
  );

  return {
    ejectKey,
  };
};

export const evictEjection = (sql: SqlStorage, ejectKey: string): void => {
  sql.exec("DELETE FROM eviction_runs WHERE ejection_key = ?", ejectKey);
  sql.exec(
    `
			DELETE FROM ejected_delivery_job_failures
			WHERE ejection_key = ?
		`,
    ejectKey,
  );
  sql.exec(
    `
			DELETE FROM ejected_delivery_jobs
			WHERE ejection_key = ?
		`,
    ejectKey,
  );
  sql.exec(
    `
			DELETE FROM ejected_payloads
			WHERE ejection_key = ?
		`,
    ejectKey,
  );
  sql.exec(
    `
			DELETE FROM ejections
			WHERE key = ?
		`,
    ejectKey,
  );
};

const mapEvictionRun = (row: {
  ejection_key: string;
  phase: EvictionRunPhase;
  cursor: string | null;
  page_index: number;
  payload_count: number;
  archive_prefix: string;
  object_id: string;
  object_name: string | null;
  cutoff: string;
  created_at: string;
  completed_at: string | null;
  next_attempt_at: string;
  retry_count: number;
  last_error: string | null;
  updated_at: string;
}): EvictionRun => ({
  ejectionKey: row.ejection_key,
  phase: row.phase,
  cursor: row.cursor,
  pageIndex: row.page_index,
  payloadCount: row.payload_count,
  archivePrefix: row.archive_prefix,
  objectId: row.object_id,
  objectName: row.object_name,
  cutoff: row.cutoff,
  createdAt: row.created_at,
  completedAt: row.completed_at,
  nextAttemptAt: row.next_attempt_at,
  retryCount: row.retry_count,
  lastError: row.last_error,
  updatedAt: row.updated_at,
});

export const getEvictionRun = (sql: SqlStorage): EvictionRun | null => {
  const row = sql
    .exec<Parameters<typeof mapEvictionRun>[0]>(
      "SELECT * FROM eviction_runs LIMIT 1",
    )
    .toArray()[0];
  return row ? mapEvictionRun(row) : null;
};

export const getActiveEjection = (
  sql: SqlStorage,
): { ejectKey: string; automatic: boolean } | null => {
  const row = sql
    .exec<{ key: string; automatic: number }>(
      `
        SELECT e.key, CASE WHEN er.ejection_key IS NULL THEN 0 ELSE 1 END AS automatic
        FROM ejections e
        LEFT JOIN eviction_runs er ON er.ejection_key = e.key
        LIMIT 1
      `,
    )
    .toArray()[0];
  return row ? { ejectKey: row.key, automatic: row.automatic === 1 } : null;
};

// Returns the timestamp used as the retention baseline for the oldest eligible
// payload. EventHub adds afterMs and one millisecond for the strict cutoff.
export const getNextEvictionBaseline = (sql: SqlStorage): string | null => {
  const row = sql
    .exec<{ baseline: string }>(
      `
        SELECT CASE
          WHEN COUNT(dj.id) = 0 THEN p.created_at
          ELSE MAX(dj.finalized_at)
        END AS baseline
        FROM payloads p
        LEFT JOIN delivery_jobs dj ON dj.payload_id = p.id
        GROUP BY p.id, p.created_at
        HAVING COUNT(dj.id) = 0
          OR SUM(CASE WHEN dj.final_status IS NULL THEN 1 ELSE 0 END) = 0
        ORDER BY baseline ASC, p.id ASC
        LIMIT 1
      `,
    )
    .toArray()[0];
  return row?.baseline ?? null;
};

export const deleteEvictionCandidates = (
  sql: SqlStorage,
  before: number,
  limit: number,
): number => {
  const beforeIso = new Date(before).toISOString();
  sql.exec("DELETE FROM automatic_eviction_candidates");
  sql.exec(
    `
			INSERT INTO automatic_eviction_candidates (payload_id)
			SELECT p.id
			FROM payloads p
			LEFT JOIN delivery_jobs dj ON dj.payload_id = p.id
			GROUP BY p.id, p.created_at
			HAVING (COUNT(dj.id) = 0 AND p.created_at < ?)
				OR (
					COUNT(dj.id) > 0
					AND SUM(CASE WHEN dj.final_status IS NULL THEN 1 ELSE 0 END) = 0
					AND MAX(dj.finalized_at) < ?
				)
			ORDER BY CASE
				WHEN COUNT(dj.id) = 0 THEN p.created_at
				ELSE MAX(dj.finalized_at)
			END ASC, p.id ASC
			LIMIT ?
		`,
    beforeIso,
    beforeIso,
    limit,
  );
  const count = sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM automatic_eviction_candidates",
    )
    .one().count;
  sql.exec(`
		DELETE FROM delivery_job_failures
		WHERE delivery_job_id IN (
			SELECT id FROM delivery_jobs
			WHERE payload_id IN (SELECT payload_id FROM automatic_eviction_candidates)
		)
	`);
  sql.exec(`
		DELETE FROM delivery_jobs
		WHERE payload_id IN (SELECT payload_id FROM automatic_eviction_candidates)
	`);
  sql.exec(`
		DELETE FROM payloads
		WHERE id IN (SELECT payload_id FROM automatic_eviction_candidates)
	`);
  sql.exec("DELETE FROM automatic_eviction_candidates");
  return count;
};

export const createAutomaticEjection = (
  sql: SqlStorage,
  before: number,
  max: number,
  ejectKey: string,
  archivePrefix: string,
  objectId: string,
  objectName: string | undefined,
  now = new Date(),
): EvictionRun | null => {
  if (getActiveEjection(sql)) return null;
  const result = ejectPayloads(sql, before, max, ejectKey, now);
  if (!result.ejectKey) return null;

  const timestamp = now.toISOString();
  sql.exec(
    `
			INSERT INTO eviction_runs (
				ejection_key, phase, cursor, page_index, payload_count,
				archive_prefix, object_id, object_name, cutoff, created_at,
				completed_at, next_attempt_at, retry_count, last_error, updated_at
			) VALUES (?, 'pages', NULL, 0, 0, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, ?)
		`,
    result.ejectKey,
    archivePrefix,
    objectId,
    objectName ?? null,
    new Date(before).toISOString(),
    timestamp,
    timestamp,
    timestamp,
  );
  return getEvictionRun(sql);
};

export const advanceEvictionPage = (
  sql: SqlStorage,
  ejectionKey: string,
  cursor: string | undefined,
  payloadCount: number,
  now = new Date(),
): void => {
  const timestamp = now.toISOString();
  sql.exec(
    `
			UPDATE eviction_runs
			SET phase = ?, cursor = ?, page_index = page_index + 1,
				payload_count = payload_count + ?, completed_at = ?,
				next_attempt_at = ?, retry_count = 0, last_error = NULL,
				updated_at = ?
			WHERE ejection_key = ?
		`,
    cursor === undefined ? "manifest" : "pages",
    cursor ?? null,
    payloadCount,
    cursor === undefined ? timestamp : null,
    timestamp,
    timestamp,
    ejectionKey,
  );
};

export const recordEvictionFailure = (
  sql: SqlStorage,
  ejectionKey: string,
  error: unknown,
  now = new Date(),
): void => {
  const run = getEvictionRun(sql);
  if (!run || run.ejectionKey !== ejectionKey) return;
  const retryCount = run.retryCount + 1;
  const delayMs = Math.min(60_000 * 2 ** (retryCount - 1), 3_600_000);
  sql.exec(
    `
			UPDATE eviction_runs
			SET retry_count = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
			WHERE ejection_key = ?
		`,
    retryCount,
    toErrorMessage(error),
    new Date(now.getTime() + delayMs).toISOString(),
    now.toISOString(),
    ejectionKey,
  );
};

export const completeAutomaticEviction = (
  sql: SqlStorage,
  ejectionKey: string,
): void => evictEjection(sql, ejectionKey);

// Records a failure report for a delivery job. Idempotent: first write wins.
// No-op if the delivery job does not exist (e.g., already ejected or evicted).
export const recordDeliveryJobFailure = (
  sql: SqlStorage,
  deliveryJobId: string,
  now = new Date(),
): boolean => {
  const reportedAt = now.toISOString();
  return (
    sql
      .exec<{ delivery_job_id: string }>(
        `
					INSERT INTO delivery_job_failures (delivery_job_id, reported_at)
					SELECT ?, ?
					WHERE EXISTS (SELECT 1 FROM delivery_jobs WHERE id = ?)
					ON CONFLICT DO NOTHING
					RETURNING delivery_job_id
				`,
        deliveryJobId,
        reportedAt,
        deliveryJobId,
      )
      .toArray().length > 0
  );
};
