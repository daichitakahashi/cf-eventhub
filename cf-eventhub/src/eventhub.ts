import { DurableObject } from "cloudflare:workers";

import {
  assertDestinationBindingsExist,
  deliverPersistedJobs,
} from "./core/delivery";
import { MonotonicUlidGenerator } from "./core/id";
import type { RoutingStrategy } from "./core/routing";
import {
  type EjectResult,
  type ListEjectedResult,
  type ListOrder,
  type ListResult,
  type PersistedDeliveryJob,
  advanceEvictionPage,
  completeAutomaticEviction,
  createAutomaticEjection,
  createPendingDeliveryJobs,
  deleteEvictionCandidates,
  ejectPayloads,
  evictEjection,
  getActiveEjection,
  getEvictionRun,
  getNextEvictionBaseline,
  getNextRetryAt,
  getRegistrySyncedAt,
  initializeSchema,
  listDeliverableJobs,
  listEjected,
  list as listPayloads,
  markDeliveryJobsCompleted,
  markDeliveryJobsFailed,
  persistDeliveryJobs,
  recordDeliveryJobFailure,
  recordEvictionFailure,
  redriveDeliveryJob,
  setRegistrySyncedAt,
} from "./core/store";
import type { EventPayload } from "./core/type";
import { EVENT_HUB_REGISTRY_NAME, type EventHubRegistry } from "./registry";

const safe: unique symbol = Symbol();

/**
 * Delivery and retry configuration for EventHub.
 */
export type DeliveryConfig = {
  [safe]: true;

  /**
   * Maximum number of delivery jobs to process in a single alarm batch.
   * Must be <= 100.
   * @default 50
   */
  alarmBatchSize: number;

  /**
   * Maximum number of delivery retry attempts before marking a job as failed.
   * @default 10
   */
  maxDeliveryRetries: number;

  /**
   * Initial delay in milliseconds before the first retry attempt.
   * @default 10000 (10 seconds)
   */
  initialRetryDelayMs: number;

  /**
   * Maximum delay in milliseconds between retry attempts.
   * Retry delays use exponential backoff capped at this value.
   * Must be >= initialRetryDelayMs.
   * @default 900000 (15 minutes)
   */
  maxRetryDelayMs: number;

  /**
   * Whether to include delivery metadata in the payload sent to destinations.
   * When enabled, instanceId, optional instanceName, and deliveryJobId are
   * added under `__eventhub__`.
   * @default false
   */
  includeDeliveryMetadata: boolean;
};

export type EvictionAction =
  | { type: "delete" }
  | { type: "archive"; bucket: R2Bucket; prefix: string };

export type EvictionConfig = {
  afterMs: number;
  action: EvictionAction;
  batchSize: number;
};

export type EjectOptions = {
  /**
   * Maximum number of payloads to move into a newly created ejection snapshot.
   * If an active snapshot already exists, that snapshot key is returned as-is.
   */
  max?: number;
};

export type ListEjectedOptions = {
  /**
   * Opaque cursor returned by the previous `listEjected()` call.
   * Omit this field to read the first page.
   */
  cursor?: string;
  /**
   * Maximum number of payloads to include in one page.
   */
  max?: number;
  /**
   * Soft page budget, in bytes, based on serialized payload bodies.
   * This limit does not cap the full RPC response size, because delivery job
   * metadata is added after page selection. The first payload is still returned
   * when present, even if its body alone exceeds this budget.
   */
  maxBytes?: number;
};

export type { ListOrder };

export type ListOptions = {
  /**
   * Opaque cursor returned by the previous `list()` call.
   * Omit this field to read the first page.
   */
  cursor?: string;
  /**
   * Maximum number of payloads to include in one page.
   */
  max?: number;
  /**
   * Soft page budget, in bytes, based on serialized payload bodies.
   * This limit does not cap the full RPC response size, because delivery job
   * metadata is added after page selection. The first payload is still returned
   * when present, even if its body alone exceeds this budget.
   */
  maxBytes?: number;
  /**
   * Sort direction by event creation time.
   * Defaults to `"asc"`.
   */
  order?: ListOrder;
};

const MAX_EJECT_PAYLOADS = 100;
const MAX_LIST_PAYLOADS = 100;
const MAX_LIST_BYTES = 262_144;
const MAX_LIST_EJECTED_PAYLOADS = 100;
const MAX_LIST_EJECTED_BYTES = 262_144;
const DEFAULT_ALARM_BATCH_SIZE = 50;
const DEFAULT_MAX_DELIVERY_RETRIES = 10;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 10_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 900_000;
const DEFAULT_INCLUDE_DELIVERY_METADATA = false;
const DEFAULT_EVICTION_BATCH_SIZE = 50;
const REGISTRY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const assertPositiveInteger = (v: number, name: string) => {
  if (Number.isInteger(v) && v > 0) return;
  throw new Error(`eventhub: ${name} must be a positive integer`);
};

function assertListOrder(v: string): asserts v is ListOrder {
  if (v === "asc" || v === "desc") return;
  throw new Error('eventhub: order must be "asc" or "desc"');
}

/**
 * Configure delivery retry settings and behavior.
 *
 * @example
 * ```ts
 * import { EventHub, configureDelivery } from "cf-eventhub";
 *
 * export class MyEventHub extends EventHub<Env> {
 *   deliveryConfig = configureDelivery({
 *     includeDeliveryMetadata: true,  // Enable job ID injection for reportFailure()
 *     initialRetryDelayMs: 5000,   // Start retry after 5 seconds
 *     maxRetryDelayMs: 300000,     // Cap retry delay at 5 minutes
 *     maxDeliveryRetries: 10,      // Retry up to 10 times
 *     alarmBatchSize: 100,         // Process 100 jobs per alarm
 *   });
 * }
 * ```
 */
export const configureDelivery = (
  c: Partial<DeliveryConfig>,
): DeliveryConfig => {
  const cfg = {
    [safe]: true as const,
    alarmBatchSize: DEFAULT_ALARM_BATCH_SIZE,
    maxDeliveryRetries: DEFAULT_MAX_DELIVERY_RETRIES,
    initialRetryDelayMs: DEFAULT_INITIAL_RETRY_DELAY_MS,
    maxRetryDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
    includeDeliveryMetadata: DEFAULT_INCLUDE_DELIVERY_METADATA,
    ...c,
  };

  assertPositiveInteger(cfg.alarmBatchSize, "alarmBatchSize");
  assertPositiveInteger(cfg.maxDeliveryRetries, "maxDeliveryRetries");
  assertPositiveInteger(cfg.initialRetryDelayMs, "initialRetryDelayMs");
  assertPositiveInteger(cfg.maxRetryDelayMs, "maxRetryDelayMs");

  if (cfg.alarmBatchSize > 100)
    throw new Error("eventhub: alarmBatchSize must be <= 100");
  if (cfg.initialRetryDelayMs > cfg.maxRetryDelayMs) {
    throw new Error("eventhub: initialRetryDelayMs must be <= maxRetryDelayMs");
  }

  return cfg;
};

export const configureEviction = (
  config: Pick<EvictionConfig, "afterMs" | "action"> &
    Partial<Pick<EvictionConfig, "batchSize">>,
): EvictionConfig => {
  assertPositiveInteger(config.afterMs, "afterMs");
  const batchSize = config.batchSize ?? DEFAULT_EVICTION_BATCH_SIZE;
  assertPositiveInteger(batchSize, "batchSize");
  if (batchSize > 100) {
    throw new Error("eventhub: batchSize must be <= 100");
  }

  const action = config.action as EvictionAction | undefined;
  if (!action || (action.type !== "delete" && action.type !== "archive")) {
    throw new Error(
      'eventhub: eviction action type must be "delete" or "archive"',
    );
  }
  if (action.type === "archive") {
    if (!action.bucket || typeof action.bucket.put !== "function") {
      throw new Error("eventhub: archive bucket is required");
    }
    if (
      typeof action.prefix !== "string" ||
      action.prefix.length === 0 ||
      action.prefix.startsWith("/") ||
      action.prefix.endsWith("/") ||
      action.prefix.includes("//")
    ) {
      throw new Error(
        "eventhub: archive prefix must be non-empty and contain no leading, trailing, or repeated slash",
      );
    }
  }
  return { afterMs: config.afterMs, action, batchSize };
};

// Durable object that persists delivery jobs and retries them via alarms.
export abstract class EventHub<
  // biome-ignore lint/complexity/noBannedTypes: default
  Env extends object = {},
> extends DurableObject<Env> {
  private readonly idGenerator: MonotonicUlidGenerator;
  private registrySyncInFlight?: Promise<void>;
  protected deliveryConfig = configureDelivery({});
  protected eviction?: EvictionConfig;
  protected registry?: DurableObjectNamespace<EventHubRegistry>;
  protected abstract routing: RoutingStrategy<Env>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.idGenerator = new MonotonicUlidGenerator();
    initializeSchema(this.ctx.storage.sql);
  }

  private scheduleRegistrySync(): void {
    const registry = this.registry;
    const name = this.ctx.id.name;
    if (
      !registry ||
      name === undefined ||
      name.length === 0 ||
      this.registrySyncInFlight
    )
      return;

    const now = Date.now();
    const syncedAt = getRegistrySyncedAt(this.ctx.storage.sql);
    if (syncedAt !== null && now - syncedAt < REGISTRY_REFRESH_INTERVAL_MS) {
      return;
    }

    const sync = (async () => {
      try {
        await registry.getByName(EVENT_HUB_REGISTRY_NAME).register(name);
        setRegistrySyncedAt(this.ctx.storage.sql, Date.now());
      } catch (error) {
        console.error("eventhub: registry synchronization failed", {
          instance: name,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.registrySyncInFlight = undefined;
      }
    })();
    this.registrySyncInFlight = sync;
    this.ctx.waitUntil(sync);
  }

  private async reconcileAlarm(): Promise<void> {
    const candidates = this.ctx.storage.transactionSync(() => {
      const result: number[] = [];
      const retryAt = getNextRetryAt(this.ctx.storage.sql);
      if (retryAt) result.push(Date.parse(retryAt));

      const eviction = this.eviction;
      if (!eviction) return result;
      const run = getEvictionRun(this.ctx.storage.sql);
      if (run) {
        if (
          eviction.action.type === "archive" &&
          eviction.action.prefix === run.archivePrefix
        ) {
          result.push(Date.parse(run.nextAttemptAt));
        }
        return result;
      }
      if (getActiveEjection(this.ctx.storage.sql)) return result;

      const baseline = getNextEvictionBaseline(this.ctx.storage.sql);
      if (baseline) result.push(Date.parse(baseline) + eviction.afterMs + 1);
      return result;
    });
    if (candidates.some(Number.isNaN)) {
      throw new Error("eventhub: invalid persisted alarm timestamp");
    }
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.min(...candidates));
    }
  }

  // Delivers persisted jobs immediately or loads the next due batch from storage.
  private async deliverPersistedJobs(
    jobs?: readonly PersistedDeliveryJob[],
  ): Promise<void> {
    const targetJobs =
      jobs ??
      this.ctx.storage.transactionSync(() =>
        listDeliverableJobs(
          this.ctx.storage.sql,
          this.deliveryConfig.alarmBatchSize,
          new Date(),
        ),
      );

    if (targetJobs.length === 0) {
      return;
    }

    await deliverPersistedJobs(
      this.routing,
      targetJobs,
      {
        onDelivered: async (jobIds) => {
          this.ctx.storage.transactionSync(() => {
            markDeliveryJobsCompleted(this.ctx.storage.sql, jobIds);
          });
        },
        onFailed: async (jobIds, error) => {
          this.ctx.storage.transactionSync(() => {
            markDeliveryJobsFailed(
              this.ctx.storage.sql,
              jobIds,
              this.deliveryConfig.maxDeliveryRetries,
              this.deliveryConfig.initialRetryDelayMs,
              this.deliveryConfig.maxRetryDelayMs,
              error,
            );
          });
        },
      },
      {
        instanceId: this.ctx.id.toString(),
        ...(this.ctx.id.name === undefined || this.ctx.id.name.length === 0
          ? {}
          : { instanceName: this.ctx.id.name }),
        includeDeliveryMetadata: this.deliveryConfig.includeDeliveryMetadata,
      },
    );
  }

  private async processEviction(now = new Date()): Promise<void> {
    const eviction = this.eviction;
    if (!eviction) return;

    let run = this.ctx.storage.transactionSync(() =>
      getEvictionRun(this.ctx.storage.sql),
    );
    if (run) {
      if (eviction.action.type !== "archive") {
        console.error("eventhub: active archive eviction paused", {
          reason: "action_changed",
          ejectionKey: run.ejectionKey,
        });
        return;
      }
      if (eviction.action.prefix !== run.archivePrefix) {
        console.error("eventhub: active archive eviction paused", {
          reason: "prefix_changed",
          ejectionKey: run.ejectionKey,
        });
        return;
      }
    } else {
      const activeEjection = this.ctx.storage.transactionSync(() =>
        getActiveEjection(this.ctx.storage.sql),
      );
      if (activeEjection) return;
      const cutoff = now.getTime() - eviction.afterMs;
      if (eviction.action.type === "delete") {
        this.ctx.storage.transactionSync(() => {
          deleteEvictionCandidates(
            this.ctx.storage.sql,
            cutoff,
            eviction.batchSize,
          );
        });
        return;
      }
      const archiveAction = eviction.action;
      run = this.ctx.storage.transactionSync(() =>
        createAutomaticEjection(
          this.ctx.storage.sql,
          cutoff,
          eviction.batchSize,
          this.idGenerator.generate(now.getTime()),
          archiveAction.prefix,
          this.ctx.id.toString(),
          this.ctx.id.name,
          now,
        ),
      );
      if (!run) return;
    }

    if (Date.parse(run.nextAttemptAt) > now.getTime()) return;
    const action = eviction.action;
    if (action.type !== "archive") return;
    const baseKey = `${run.archivePrefix}/objects/${run.objectId}/ejections/${run.ejectionKey}`;
    if (run.phase === "pages") {
      const page = this.ctx.storage.transactionSync(() =>
        listEjected(
          this.ctx.storage.sql,
          run.ejectionKey,
          run.cursor ?? undefined,
          MAX_LIST_EJECTED_PAYLOADS,
          MAX_LIST_EJECTED_BYTES,
        ),
      );
      if (page.payloads.length === 0) {
        throw new Error("eventhub: automatic ejection snapshot is empty");
      }
      const object = {
        id: run.objectId,
        ...(run.objectName ? { name: run.objectName } : {}),
      };
      const body = JSON.stringify({
        formatVersion: 1,
        object,
        ejectionKey: run.ejectionKey,
        pageIndex: run.pageIndex,
        payloads: page.payloads,
      });
      const key = `${baseKey}/pages/${String(run.pageIndex).padStart(6, "0")}.json`;
      try {
        await action.bucket.put(key, body, {
          httpMetadata: { contentType: "application/json" },
        });
      } catch (error) {
        this.ctx.storage.transactionSync(() =>
          recordEvictionFailure(this.ctx.storage.sql, run.ejectionKey, error),
        );
        return;
      }
      this.ctx.storage.transactionSync(() =>
        advanceEvictionPage(
          this.ctx.storage.sql,
          run.ejectionKey,
          page.cursor,
          page.payloads.length,
        ),
      );
      return;
    }

    if (!run.completedAt) {
      throw new Error("eventhub: eviction manifest is missing completed_at");
    }
    const manifest = JSON.stringify({
      formatVersion: 1,
      object: {
        id: run.objectId,
        ...(run.objectName ? { name: run.objectName } : {}),
      },
      ejectionKey: run.ejectionKey,
      cutoff: run.cutoff,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      pageCount: run.pageIndex,
      payloadCount: run.payloadCount,
    });
    try {
      await action.bucket.put(`${baseKey}/manifest.json`, manifest, {
        httpMetadata: { contentType: "application/json" },
      });
    } catch (error) {
      this.ctx.storage.transactionSync(() =>
        recordEvictionFailure(this.ctx.storage.sql, run.ejectionKey, error),
      );
      return;
    }
    this.ctx.storage.transactionSync(() =>
      completeAutomaticEviction(this.ctx.storage.sql, run.ejectionKey),
    );
  }

  /**
   * Persists routed jobs and kicks off their first delivery attempt.
   * @param payload First payload to publish.
   * @param rest Additional payloads published in the same batch.
   */
  async publish(payload: EventPayload, ...rest: EventPayload[]): Promise<void> {
    const pendingDeliveryJobs = createPendingDeliveryJobs(this.routing, [
      payload,
      ...rest,
    ]);
    assertDestinationBindingsExist(this.routing, pendingDeliveryJobs);

    const persistedJobs = this.ctx.storage.transactionSync(() =>
      persistDeliveryJobs(
        this.ctx.storage.sql,
        pendingDeliveryJobs,
        (now) => this.idGenerator.generate(now),
        new Date(),
        this.deliveryConfig.initialRetryDelayMs,
      ),
    );
    await this.reconcileAlarm();
    this.ctx.waitUntil(
      (async () => {
        await this.deliverPersistedJobs(persistedJobs);
        await this.reconcileAlarm();
      })(),
    );
    this.scheduleRegistrySync();
  }

  /**
   * Creates a new independent delivery job from an existing job and starts
   * delivery immediately. The new job stores its own payload row and does not
   * retain a reference to the original job.
   * @param deliveryJobId Existing delivery job ID to redrive.
   * @returns `true` when a new job is created, or `false` when the source job
   * no longer exists.
   */
  async redrive(deliveryJobId: string): Promise<boolean> {
    if (deliveryJobId.length === 0) {
      throw new Error("eventhub: deliveryJobId must not be empty");
    }

    const persistedJob = this.ctx.storage.transactionSync(() =>
      redriveDeliveryJob(
        this.ctx.storage.sql,
        deliveryJobId,
        (now) => this.idGenerator.generate(now),
        new Date(),
        this.deliveryConfig.initialRetryDelayMs,
      ),
    );
    if (!persistedJob) {
      await this.reconcileAlarm();
      this.scheduleRegistrySync();
      return false;
    }

    await this.reconcileAlarm();
    this.ctx.waitUntil(
      (async () => {
        await this.deliverPersistedJobs([persistedJob]);
        await this.reconcileAlarm();
      })(),
    );
    this.scheduleRegistrySync();
    return true;
  }

  /**
   * Lists live payloads with bounded page size and payload-body size budget.
   * @param options Optional pagination settings such as cursor, item count, and
   * payload-body byte budget. `options.max` defaults to `50` and must be an
   * integer in the range `1..100`. `options.maxBytes` defaults to `262144`
   * and must be an integer in the range `1..262144`. The first payload is
   * still returned when present, even if its body alone exceeds this budget.
   */
  async list(options?: ListOptions): Promise<ListResult> {
    const order = options?.order ?? "asc";
    assertListOrder(order);

    const max = options?.max;
    if (max !== undefined) {
      assertPositiveInteger(max, "max");
      if (max > MAX_LIST_PAYLOADS)
        throw new Error(`eventhub: max must be <= ${MAX_LIST_PAYLOADS}`);
    }

    const maxBytes = options?.maxBytes;
    if (maxBytes !== undefined) {
      assertPositiveInteger(maxBytes, "maxBytes");
      if (maxBytes > MAX_LIST_BYTES)
        throw new Error(`eventhub: maxBytes must be <= ${MAX_LIST_BYTES}`);
    }

    const result = this.ctx.storage.transactionSync(() =>
      listPayloads(
        this.ctx.storage.sql,
        options?.cursor,
        max ?? 50,
        maxBytes ?? MAX_LIST_BYTES,
        order,
      ),
    );
    await this.reconcileAlarm();
    this.scheduleRegistrySync();
    return result;
  }

  /**
   * Extracts finalized payloads older than the cutoff into a singleton
   * ejection snapshot.
   * @param before Unix time in milliseconds. Finalized payloads older than this
   * cutoff become ejection candidates.
   * @param options Optional limits for creating a new ejection snapshot.
   * `options.max` defaults to `50` and must be an integer in the range
   * `1..100`.
   */
  async eject(before: number, options?: EjectOptions): Promise<EjectResult> {
    if (!Number.isFinite(before)) {
      throw new Error("eventhub: before must be a finite number");
    }

    const max = options?.max;
    if (max !== undefined) {
      assertPositiveInteger(max, "max");
      if (max > MAX_EJECT_PAYLOADS)
        throw new Error(`eventhub: max must be <= ${MAX_EJECT_PAYLOADS}`);
    }

    const result = this.ctx.storage.transactionSync(() =>
      ejectPayloads(
        this.ctx.storage.sql,
        before,
        max ?? 50,
        this.idGenerator.generate(Date.now()),
      ),
    );
    await this.reconcileAlarm();
    this.scheduleRegistrySync();
    return result;
  }

  /**
   * Lists payloads from an ejection snapshot with bounded page size and
   * payload-body size budget.
   * @param ejectKey Snapshot key returned by `eject()`.
   * @param options Optional pagination settings such as cursor, item count, and
   * payload-body byte budget. `options.max` defaults to `50` and must be an
   * integer in the range `1..100`. `options.maxBytes` defaults to `262144`
   * and must be an integer in the range `1..262144`.
   */
  async listEjected(
    ejectKey: string,
    options?: ListEjectedOptions,
  ): Promise<ListEjectedResult> {
    if (ejectKey.length === 0) {
      throw new Error("eventhub: ejectKey must not be empty");
    }

    const max = options?.max;
    if (max !== undefined) {
      assertPositiveInteger(max, "max");
      if (max > MAX_LIST_EJECTED_PAYLOADS)
        throw new Error(
          `eventhub: max must be <= ${MAX_LIST_EJECTED_PAYLOADS}`,
        );
    }

    const maxBytes = options?.maxBytes;
    if (maxBytes !== undefined) {
      assertPositiveInteger(maxBytes, "maxBytes");
      if (maxBytes > MAX_LIST_EJECTED_BYTES)
        throw new Error(
          `eventhub: maxBytes must be <= ${MAX_LIST_EJECTED_BYTES}`,
        );
    }

    const result = this.ctx.storage.transactionSync(() =>
      listEjected(
        this.ctx.storage.sql,
        ejectKey,
        options?.cursor,
        max ?? 50,
        maxBytes ?? MAX_LIST_EJECTED_BYTES,
      ),
    );
    await this.reconcileAlarm();
    this.scheduleRegistrySync();
    return result;
  }

  /**
   * Removes a previously ejected snapshot. This operation is idempotent.
   * @param ejectKey Snapshot key returned by `eject()`.
   */
  async evict(ejectKey: string): Promise<void> {
    if (ejectKey.length === 0) {
      throw new Error("eventhub: ejectKey must not be empty");
    }

    this.ctx.storage.transactionSync(() => {
      evictEjection(this.ctx.storage.sql, ejectKey);
    });
    await this.reconcileAlarm();
    this.scheduleRegistrySync();
  }

  /**
   * Retries delivery for jobs whose retry time has arrived.
   */
  async alarm(): Promise<void> {
    await this.deliverPersistedJobs();
    await this.processEviction();
    await this.reconcileAlarm();
    this.scheduleRegistrySync();
  }

  /**
   * Records a consumer-reported failure for a delivery job. This operation is
   * idempotent: the first call for a given job ID records the failure, and
   * subsequent calls have no effect.
   *
   * **Typical Usage: Dead-Letter Queue Consumer**
   *
   * The recommended pattern is to configure a shared DLQ for all EventHub
   * destination queues and call `reportFailure()` from the DLQ consumer:
   *
   * ```ts
   * import { getEventHubFromPayload } from "cf-eventhub";
   *
   * // DLQ consumer
   * export default {
   *   async queue(batch: MessageBatch, env: Env): Promise<void> {
   *     for (const message of batch.messages) {
   *       try {
   *         const hub = getEventHubFromPayload(env.EVENT_HUB, message.body);
   *         if (!hub) {
   *           message.retry();
   *           continue;
   *         }
   *         await hub.reportFailure(message.body);
   *         message.ack();
   *       } catch (error) {
   *         console.error("Failed to report failure:", error);
   *         message.retry();
   *       }
   *     }
   *   },
   * };
   * ```
   *
   * **Prerequisites:**
   * - Set `includeDeliveryMetadata: true` in your `deliveryConfig`
   * - Configure DLQs for your destination queues in `wrangler.jsonc`
   *
   * @param payload The payload that was delivered. Must be an object containing
   * matching `__eventhub__.instanceId` and `__eventhub__.deliveryJobId`.
   * @returns `true` when a new failure record is written, or `false` when no
   * record is added because the job was already recorded or no longer exists.
   * @throws {Error} If the payload is not an object or if the delivery job ID
   * cannot be extracted, or the instance ID does not match.
   */
  async reportFailure(payload: unknown): Promise<boolean> {
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error("eventhub: payload must be an object");
    }

    const eventhubMetadata = (payload as Record<string, unknown>).__eventhub__;
    if (
      typeof eventhubMetadata !== "object" ||
      eventhubMetadata === null ||
      Array.isArray(eventhubMetadata)
    ) {
      throw new Error(
        "eventhub: __eventhub__ metadata not found or invalid in payload",
      );
    }

    const deliveryJobId = (eventhubMetadata as Record<string, unknown>)
      .deliveryJobId;
    if (typeof deliveryJobId !== "string" || deliveryJobId.length === 0) {
      throw new Error("eventhub: deliveryJobId must be a non-empty string");
    }

    if (
      (eventhubMetadata as Record<string, unknown>).instanceId !==
      this.ctx.id.toString()
    ) {
      throw new Error("eventhub: instanceId does not match this instance");
    }

    const recorded = this.ctx.storage.transactionSync(() =>
      recordDeliveryJobFailure(this.ctx.storage.sql, deliveryJobId),
    );
    await this.reconcileAlarm();
    this.scheduleRegistrySync();
    return recorded;
  }
}
