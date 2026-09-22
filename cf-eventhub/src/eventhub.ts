import { DurableObject } from "cloudflare:workers";

import {
  deliverPersistedJobs,
  type ResolvedDestinations,
  resolveDestinationBindings,
  validatePendingQueueMessageSizes,
} from "./core/delivery";
import { MonotonicUlidGenerator } from "./core/id";
import type { RoutingStrategy } from "./core/routing";
import {
  advanceEvictionPage,
  claimDeliverableJobs,
  claimDeliveryJobs,
  completeAutomaticEviction,
  createAutomaticEjection,
  createPendingDeliveryJobs,
  deleteEvictionCandidates,
  type EjectResult,
  ejectPayloads,
  evictEjection,
  getActiveEjection,
  getEvictionRun,
  getNextEvictionBaseline,
  getNextRetryAt,
  getRegistrySyncedAt,
  initializeSchema,
  type ListEjectedResult,
  type ListOrder,
  type ListResult,
  listEjected,
  list as listPayloads,
  markDeliveryJobsCompleted,
  markDeliveryJobsFailed,
  type PendingDeliveryJobs,
  type PersistedDeliveryJob,
  persistDeliveryJobs,
  recordDeliveryJobFailure,
  recordEvictionFailure,
  redriveDeliveryJob,
  renewDeliveryJobLeases,
  setRegistrySyncedAt,
  validatePaginationCursor,
} from "./core/store";
import type { EventPayload } from "./core/type";
import {
  type Result,
  resultError,
  resultOk,
  rpcBoundary,
  serializeError,
} from "./errors";
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
   * Duration in milliseconds for which a delivery attempt owns its jobs.
   * An interrupted attempt becomes eligible again after this lease expires.
   * @default 300000 (5 minutes)
   */
  deliveryAttemptLeaseMs?: number;

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
const DEFAULT_DELIVERY_ATTEMPT_LEASE_MS = 300_000;
const DEFAULT_INCLUDE_DELIVERY_METADATA = false;
const DEFAULT_EVICTION_BATCH_SIZE = 50;
const REGISTRY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const assertPositiveInteger = (v: number, name: string) => {
  if (Number.isInteger(v) && v > 0) return;
  throw new Error(`eventhub: ${name} must be a positive integer`);
};

type ValidatedPageOptions = {
  cursor?: string;
  max: number;
  maxBytes: number;
};

type ValidatedListOptions = ValidatedPageOptions & {
  order: ListOrder;
};

const validatePageOptions = (
  options: Pick<ListOptions, "cursor" | "max" | "maxBytes"> | undefined,
  maxLimit: number,
  maxBytesLimit: number,
): Result<ValidatedPageOptions> => {
  const max = options?.max ?? 50;
  if (!Number.isInteger(max) || max <= 0) {
    return resultError(
      "INVALID_ARGUMENT",
      "eventhub: max must be a positive integer",
    );
  }
  if (max > maxLimit) {
    return resultError(
      "INVALID_ARGUMENT",
      `eventhub: max must be <= ${maxLimit}`,
    );
  }
  const maxBytes = options?.maxBytes ?? maxBytesLimit;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    return resultError(
      "INVALID_ARGUMENT",
      "eventhub: maxBytes must be a positive integer",
    );
  }
  if (maxBytes > maxBytesLimit) {
    return resultError(
      "INVALID_ARGUMENT",
      `eventhub: maxBytes must be <= ${maxBytesLimit}`,
    );
  }
  const cursor = validatePaginationCursor(options?.cursor);
  if (!cursor.ok) return cursor;
  return resultOk({
    ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
    max,
    maxBytes,
  });
};

const validateListOptions = (
  options?: ListOptions,
): Result<ValidatedListOptions> => {
  const order = options?.order ?? "asc";
  if (order !== "asc" && order !== "desc") {
    return resultError(
      "INVALID_ARGUMENT",
      'eventhub: order must be "asc" or "desc"',
    );
  }
  const page = validatePageOptions(options, MAX_LIST_PAYLOADS, MAX_LIST_BYTES);
  if (!page.ok) return page;
  return resultOk({ ...page.value, order });
};

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
 *     deliveryAttemptLeaseMs: 300000, // Recover interrupted attempts after 5 minutes
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
    deliveryAttemptLeaseMs: DEFAULT_DELIVERY_ATTEMPT_LEASE_MS,
    includeDeliveryMetadata: DEFAULT_INCLUDE_DELIVERY_METADATA,
    ...c,
  };

  assertPositiveInteger(cfg.alarmBatchSize, "alarmBatchSize");
  assertPositiveInteger(cfg.maxDeliveryRetries, "maxDeliveryRetries");
  assertPositiveInteger(cfg.initialRetryDelayMs, "initialRetryDelayMs");
  assertPositiveInteger(cfg.maxRetryDelayMs, "maxRetryDelayMs");
  assertPositiveInteger(cfg.deliveryAttemptLeaseMs, "deliveryAttemptLeaseMs");

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
  private readonly activeDeliveryAttempts = new Set<string>();
  private registrySyncInFlight?: Promise<void>;
  protected deliveryConfig = configureDelivery({});
  protected eviction?: EvictionConfig;
  protected registry?: DurableObjectNamespace<EventHubRegistry>;
  protected abstract routing: RoutingStrategy<Env>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.idGenerator = new MonotonicUlidGenerator();
    initializeSchema(this.ctx.storage);
  }

  private rpcContext(): Record<string, unknown> {
    return {
      instanceId: this.ctx.id.toString(),
      ...(this.ctx.id.name ? { instanceName: this.ctx.id.name } : {}),
    };
  }

  publish(payload: EventPayload, ...rest: EventPayload[]): Promise<Result> {
    return rpcBoundary(
      "publish",
      async () => {
        const pending = createPendingDeliveryJobs(this.routing, [
          payload,
          ...rest,
        ]);
        if (!pending.ok) return pending;
        const resolved = resolveDestinationBindings(
          this.routing,
          pending.value,
        );
        if (!resolved.ok) return resolved;
        const size = validatePendingQueueMessageSizes(
          resolved.value,
          pending.value,
          {
            instanceId: this.ctx.id.toString(),
            ...(this.ctx.id.name ? { instanceName: this.ctx.id.name } : {}),
            includeDeliveryMetadata:
              this.deliveryConfig.includeDeliveryMetadata,
          },
        );
        if (!size.ok) return size;
        await this.#publish(pending.value, resolved.value);
        return resultOk();
      },
      this.rpcContext(),
    );
  }

  redrive(deliveryJobId: string): Promise<Result<boolean>> {
    return rpcBoundary(
      "redrive",
      async () => {
        if (deliveryJobId.length === 0) {
          return resultError(
            "INVALID_ARGUMENT",
            "eventhub: deliveryJobId must not be empty",
          );
        }
        return resultOk(await this.#redrive(deliveryJobId));
      },
      this.rpcContext(),
    );
  }

  list(options?: ListOptions): Promise<Result<ListResult>> {
    return rpcBoundary(
      "list",
      async () => {
        const validated = validateListOptions(options);
        if (!validated.ok) return validated;
        return this.#list(validated.value);
      },
      this.rpcContext(),
    );
  }

  eject(before: number, options?: EjectOptions): Promise<Result<EjectResult>> {
    return rpcBoundary(
      "eject",
      async () => {
        if (!Number.isFinite(before)) {
          return resultError(
            "INVALID_ARGUMENT",
            "eventhub: before must be a finite number",
          );
        }
        const max = options?.max ?? 50;
        if (!Number.isInteger(max) || max <= 0) {
          return resultError(
            "INVALID_ARGUMENT",
            "eventhub: max must be a positive integer",
          );
        }
        if (max > MAX_EJECT_PAYLOADS) {
          return resultError(
            "INVALID_ARGUMENT",
            `eventhub: max must be <= ${MAX_EJECT_PAYLOADS}`,
          );
        }
        return resultOk(await this.#eject(before, max));
      },
      this.rpcContext(),
    );
  }

  listEjected(
    ejectKey: string,
    options?: ListEjectedOptions,
  ): Promise<Result<ListEjectedResult>> {
    return rpcBoundary(
      "listEjected",
      async () => {
        if (ejectKey.length === 0) {
          return resultError(
            "INVALID_ARGUMENT",
            "eventhub: ejectKey must not be empty",
          );
        }
        const validated = validatePageOptions(
          options,
          MAX_LIST_EJECTED_PAYLOADS,
          MAX_LIST_EJECTED_BYTES,
        );
        if (!validated.ok) return validated;
        return this.#listEjected(ejectKey, validated.value);
      },
      this.rpcContext(),
    );
  }

  evict(ejectKey: string): Promise<Result> {
    return rpcBoundary(
      "evict",
      async () => {
        if (ejectKey.length === 0) {
          return resultError(
            "INVALID_ARGUMENT",
            "eventhub: ejectKey must not be empty",
          );
        }
        await this.#evict(ejectKey);
        return resultOk();
      },
      this.rpcContext(),
    );
  }

  reportFailure(payload: unknown): Promise<Result<boolean>> {
    return rpcBoundary(
      "reportFailure",
      async () => {
        const deliveryJobId = this.validateFailurePayload(payload);
        if (!deliveryJobId.ok) return deliveryJobId;
        return resultOk(await this.#reportFailure(deliveryJobId.value));
      },
      this.rpcContext(),
    );
  }

  private validateFailurePayload(payload: unknown): Result<string> {
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return resultError(
        "INVALID_ARGUMENT",
        "eventhub: payload must be an object",
      );
    }
    const eventhubMetadata = (payload as Record<string, unknown>).__eventhub__;
    if (
      typeof eventhubMetadata !== "object" ||
      eventhubMetadata === null ||
      Array.isArray(eventhubMetadata)
    ) {
      return resultError(
        "INVALID_ARGUMENT",
        "eventhub: __eventhub__ metadata not found or invalid in payload",
      );
    }
    const deliveryJobId = (eventhubMetadata as Record<string, unknown>)
      .deliveryJobId;
    if (typeof deliveryJobId !== "string" || deliveryJobId.length === 0) {
      return resultError(
        "INVALID_ARGUMENT",
        "eventhub: deliveryJobId must be a non-empty string",
      );
    }
    if (
      (eventhubMetadata as Record<string, unknown>).instanceId !==
      this.ctx.id.toString()
    ) {
      return resultError(
        "INSTANCE_MISMATCH",
        "eventhub: instanceId does not match this instance",
      );
    }
    return resultOk(deliveryJobId);
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
        const result = await registry
          .getByName(EVENT_HUB_REGISTRY_NAME)
          .register(name);
        if (!result.ok) {
          console.warn("eventhub: registry synchronization failed", {
            operation: "registry_synchronization",
            instanceId: this.ctx.id.toString(),
            instanceName: name,
            error: result.error,
          });
          return;
        }
        setRegistrySyncedAt(this.ctx.storage.sql, Date.now());
      } catch (error) {
        console.warn("eventhub: registry synchronization failed", {
          operation: "registry_synchronization",
          instanceId: this.ctx.id.toString(),
          instanceName: name,
          error: serializeError(error),
        });
      } finally {
        this.registrySyncInFlight = undefined;
      }
    })();
    this.registrySyncInFlight = sync;
    this.ctx.waitUntil(sync);
  }

  private async reconcileAlarm(): Promise<void> {
    const candidates: number[] = [];
    const retryAt = getNextRetryAt(this.ctx.storage.sql);
    if (retryAt) candidates.push(Date.parse(retryAt));

    const eviction = this.eviction;
    if (eviction) {
      const run = getEvictionRun(this.ctx.storage.sql);
      if (
        run &&
        eviction.action.type === "archive" &&
        eviction.action.prefix === run.archivePrefix
      ) {
        candidates.push(Date.parse(run.nextAttemptAt));
      } else if (!run && !getActiveEjection(this.ctx.storage.sql)) {
        const baseline = getNextEvictionBaseline(this.ctx.storage.sql);
        if (baseline) {
          candidates.push(Date.parse(baseline) + eviction.afterMs + 1);
        }
      }
    }
    if (candidates.some(Number.isNaN)) {
      throw new Error("eventhub: invalid persisted alarm timestamp");
    }
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.min(...candidates));
    }
  }

  private async runInTransactionWithAlarmReconciliation<T>(
    callback: () => T | Promise<T>,
  ): Promise<T> {
    return this.ctx.storage.transaction(async () => {
      const result = await callback();
      await this.reconcileAlarm();
      return result;
    });
  }

  // Delivers persisted jobs immediately or loads the next due batch from storage.
  private async deliverPersistedJobs(
    jobs?: readonly PersistedDeliveryJob[],
    resolvedDestinations?: ResolvedDestinations<Env>,
  ): Promise<void> {
    const leaseToken = this.idGenerator.generate(Date.now());
    const leaseDurationMs =
      this.deliveryConfig.deliveryAttemptLeaseMs ??
      DEFAULT_DELIVERY_ATTEMPT_LEASE_MS;
    // Register before the first await so a concurrent claim cannot steal jobs
    // between committing this attempt's lease and resuming its delivery.
    this.activeDeliveryAttempts.add(leaseToken);
    try {
      const claim = await this.runInTransactionWithAlarmReconciliation(() => {
        const now = new Date();
        renewDeliveryJobLeases(
          this.ctx.storage.sql,
          [...this.activeDeliveryAttempts],
          leaseDurationMs,
          now,
        );
        return jobs
          ? claimDeliveryJobs(
              this.ctx.storage.sql,
              jobs.map(({ id }) => id),
              leaseToken,
              leaseDurationMs,
              now,
            )
          : claimDeliverableJobs(
              this.ctx.storage.sql,
              this.deliveryConfig.alarmBatchSize,
              leaseToken,
              leaseDurationMs,
              now,
            );
      });
      const targetJobs = claim.jobs;

      if (targetJobs.length === 0) {
        return;
      }

      await deliverPersistedJobs(
        this.routing,
        targetJobs,
        {
          onDelivered: async (jobIds) => {
            await this.runInTransactionWithAlarmReconciliation(() => {
              markDeliveryJobsCompleted(
                this.ctx.storage.sql,
                jobIds,
                new Date(),
                claim.leaseToken,
              );
            });
          },
          onFailed: async (jobIds, error) => {
            const failureStates =
              await this.runInTransactionWithAlarmReconciliation(() =>
                markDeliveryJobsFailed(
                  this.ctx.storage.sql,
                  jobIds,
                  this.deliveryConfig.maxDeliveryRetries,
                  this.deliveryConfig.initialRetryDelayMs,
                  this.deliveryConfig.maxRetryDelayMs,
                  error,
                  new Date(),
                  claim.leaseToken,
                ),
              );
            const jobsById = new Map(targetJobs.map((job) => [job.id, job]));
            for (const state of failureStates) {
              const job = jobsById.get(state.jobId);
              const context = {
                operation: "delivery",
                instanceId: this.ctx.id.toString(),
                ...(this.ctx.id.name ? { instanceName: this.ctx.id.name } : {}),
                deliveryJobId: state.jobId,
                ...(job
                  ? { payloadId: job.payloadId, destination: job.destination }
                  : {}),
                failedAttemptCount: state.failedAttemptCount,
                ...(state.nextRetryAt
                  ? { nextRetryAt: state.nextRetryAt }
                  : {}),
                error: serializeError(error),
              };
              if (state.finalStatus === "failed") {
                console.error("eventhub: delivery permanently failed", context);
              } else {
                console.warn("eventhub: delivery attempt failed", context);
              }
            }
          },
        },
        {
          instanceId: this.ctx.id.toString(),
          ...(this.ctx.id.name === undefined || this.ctx.id.name.length === 0
            ? {}
            : { instanceName: this.ctx.id.name }),
          includeDeliveryMetadata: this.deliveryConfig.includeDeliveryMetadata,
        },
        resolvedDestinations,
      );
    } finally {
      this.activeDeliveryAttempts.delete(leaseToken);
    }
  }

  private async processEviction(now = new Date()): Promise<void> {
    const eviction = this.eviction;
    let run = this.ctx.storage.transactionSync(() =>
      getEvictionRun(this.ctx.storage.sql),
    );
    if (!eviction) {
      if (run) {
        console.error("eventhub: active archive eviction paused", {
          operation: "automatic_eviction",
          instanceId: this.ctx.id.toString(),
          ...(this.ctx.id.name ? { instanceName: this.ctx.id.name } : {}),
          reason: "eviction_disabled",
          ejectionKey: run.ejectionKey,
        });
      }
      return;
    }

    if (run) {
      if (eviction.action.type !== "archive") {
        console.error("eventhub: active archive eviction paused", {
          operation: "automatic_eviction",
          instanceId: this.ctx.id.toString(),
          ...(this.ctx.id.name ? { instanceName: this.ctx.id.name } : {}),
          reason: "action_changed",
          ejectionKey: run.ejectionKey,
        });
        return;
      }
      if (eviction.action.prefix !== run.archivePrefix) {
        console.error("eventhub: active archive eviction paused", {
          operation: "automatic_eviction",
          instanceId: this.ctx.id.toString(),
          ...(this.ctx.id.name ? { instanceName: this.ctx.id.name } : {}),
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
        await this.runInTransactionWithAlarmReconciliation(() => {
          deleteEvictionCandidates(
            this.ctx.storage.sql,
            cutoff,
            eviction.batchSize,
          );
        });
        return;
      }
      const archiveAction = eviction.action;
      run = await this.runInTransactionWithAlarmReconciliation(() =>
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
      const pageResult = this.ctx.storage.transactionSync(() =>
        listEjected(
          this.ctx.storage.sql,
          run.ejectionKey,
          run.cursor ?? undefined,
          MAX_LIST_EJECTED_PAYLOADS,
          MAX_LIST_EJECTED_BYTES,
        ),
      );
      if (!pageResult.ok) {
        throw new Error(pageResult.error.message);
      }
      const page = pageResult.value;
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
        const retryState = await this.runInTransactionWithAlarmReconciliation(
          () =>
            recordEvictionFailure(this.ctx.storage.sql, run.ejectionKey, error),
        );
        console.warn("eventhub: automatic eviction write failed", {
          operation: "automatic_eviction",
          instanceId: this.ctx.id.toString(),
          ...(this.ctx.id.name ? { instanceName: this.ctx.id.name } : {}),
          ejectionKey: run.ejectionKey,
          phase: run.phase,
          objectKey: key,
          ...retryState,
          error: serializeError(error),
        });
        return;
      }
      await this.runInTransactionWithAlarmReconciliation(() => {
        advanceEvictionPage(
          this.ctx.storage.sql,
          run.ejectionKey,
          page.cursor,
          page.payloads.length,
        );
      });
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
      const retryState = await this.runInTransactionWithAlarmReconciliation(
        () =>
          recordEvictionFailure(this.ctx.storage.sql, run.ejectionKey, error),
      );
      console.warn("eventhub: automatic eviction write failed", {
        operation: "automatic_eviction",
        instanceId: this.ctx.id.toString(),
        ...(this.ctx.id.name ? { instanceName: this.ctx.id.name } : {}),
        ejectionKey: run.ejectionKey,
        phase: run.phase,
        objectKey: `${baseKey}/manifest.json`,
        ...retryState,
        error: serializeError(error),
      });
      return;
    }
    await this.runInTransactionWithAlarmReconciliation(() => {
      completeAutomaticEviction(this.ctx.storage.sql, run.ejectionKey);
    });
  }

  /**
   * Persists routed jobs and kicks off their first delivery attempt.
   * @param payload First payload to publish.
   * @param rest Additional payloads published in the same batch.
   */
  async #publish(
    pendingDeliveryJobs: PendingDeliveryJobs,
    resolvedDestinations: ResolvedDestinations<Env>,
  ): Promise<void> {
    const persistedJobs = await this.runInTransactionWithAlarmReconciliation(
      () =>
        persistDeliveryJobs(
          this.ctx.storage.sql,
          pendingDeliveryJobs,
          (now) => this.idGenerator.generate(now),
          new Date(),
          this.deliveryConfig.initialRetryDelayMs,
        ),
    );
    this.ctx.waitUntil(
      (async () => {
        await this.deliverPersistedJobs(persistedJobs, resolvedDestinations);
        await this.runInTransactionWithAlarmReconciliation(() => undefined);
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
  async #redrive(deliveryJobId: string): Promise<boolean> {
    const persistedJob = await this.runInTransactionWithAlarmReconciliation(
      () =>
        redriveDeliveryJob(
          this.ctx.storage.sql,
          deliveryJobId,
          (now) => this.idGenerator.generate(now),
          new Date(),
          this.deliveryConfig.initialRetryDelayMs,
        ),
    );
    if (!persistedJob) {
      this.scheduleRegistrySync();
      return false;
    }

    this.ctx.waitUntil(
      (async () => {
        await this.deliverPersistedJobs([persistedJob]);
        await this.runInTransactionWithAlarmReconciliation(() => undefined);
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
  async #list(options: ValidatedListOptions): Promise<Result<ListResult>> {
    return this.runInTransactionWithAlarmReconciliation(() =>
      listPayloads(
        this.ctx.storage.sql,
        options.cursor,
        options.max,
        options.maxBytes,
        options.order,
      ),
    );
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
  async #eject(before: number, max: number): Promise<EjectResult> {
    const result = await this.runInTransactionWithAlarmReconciliation(() =>
      ejectPayloads(
        this.ctx.storage.sql,
        before,
        max,
        this.idGenerator.generate(Date.now()),
      ),
    );
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
  async #listEjected(
    ejectKey: string,
    options: ValidatedPageOptions,
  ): Promise<Result<ListEjectedResult>> {
    return this.runInTransactionWithAlarmReconciliation(() =>
      listEjected(
        this.ctx.storage.sql,
        ejectKey,
        options.cursor,
        options.max,
        options.maxBytes,
      ),
    );
  }

  /**
   * Removes a previously ejected snapshot. This operation is idempotent.
   * @param ejectKey Snapshot key returned by `eject()`.
   */
  async #evict(ejectKey: string): Promise<void> {
    await this.runInTransactionWithAlarmReconciliation(() => {
      evictEjection(this.ctx.storage.sql, ejectKey);
    });
    this.scheduleRegistrySync();
  }

  /**
   * Retries delivery for jobs whose retry time has arrived.
   */
  async alarm(): Promise<void> {
    await this.deliverPersistedJobs();
    await this.processEviction();
    await this.runInTransactionWithAlarmReconciliation(() => undefined);
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
   *         const result = await hub.reportFailure(message.body);
   *         if (result.ok) message.ack();
   *         else message.retry();
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
   * @returns A result containing `true` when a new failure record is written,
   * or `false` when the job was already recorded or no longer exists.
   */
  async #reportFailure(deliveryJobId: string): Promise<boolean> {
    const recorded = await this.runInTransactionWithAlarmReconciliation(() =>
      recordDeliveryJobFailure(this.ctx.storage.sql, deliveryJobId),
    );
    this.scheduleRegistrySync();
    return recorded;
  }
}
