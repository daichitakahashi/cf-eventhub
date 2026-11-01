import {
  env,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  EventHub,
  type EventPayload,
  routeByConfig,
  routeFunc,
} from "cf-eventhub";
import { MonotonicUlidGenerator } from "../../cf-eventhub/src/core/id";
import {
  claimDeliverableJobs,
  createPendingDeliveryJobs,
  list as listStoredPayloads,
  markDeliveryJobsCompleted,
  persistDeliveryJobs,
} from "../../cf-eventhub/src/core/store";

type BenchmarkEnv = Env & { BENCHMARK_TOKEN: string };
const runtimeEnv = env as BenchmarkEnv;

type Destination = "none" | "queue" | "r2" | "workflow";
type BenchmarkPayload = EventPayload & {
  benchmarkDestination: Destination | "retry";
};

const MAX_BATCH_SIZE = 100;
const MAX_PADDING_BYTES = 16_384;
const HUB_NAME_PATTERN = /^[a-zA-Z0-9:_-]{1,128}$/;

const storageStats = (storage: DurableObjectStorage) => ({
  payloads: storage.sql.exec("SELECT COUNT(*) AS count FROM payloads").one()
    .count,
  jobs: storage.sql
    .exec(
      "SELECT final_status, COUNT(*) AS count FROM delivery_jobs GROUP BY final_status",
    )
    .toArray(),
});

export class BenchmarkEventHub extends EventHub<BenchmarkEnv> {
  profileList() {
    const cursors: ReturnType<SqlStorage["exec"]>[] = [];
    const queries: { query: string; bindings: SqlStorageValue[] }[] = [];
    const sql = this.ctx.storage.sql;
    const measuredSql = {
      exec: (query: string, ...bindings: SqlStorageValue[]) => {
        const cursor = sql.exec(query, ...bindings);
        cursors.push(cursor);
        queries.push({ query, bindings });
        return cursor;
      },
    } as unknown as SqlStorage;
    const started = performance.now();
    const page = listStoredPayloads(measuredSql, undefined, 100);
    const elapsedMs = performance.now() - started;
    return {
      ok: page.ok,
      elapsedMs,
      rowsRead: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      plans: queries.map(({ query, bindings }) =>
        sql.exec(`EXPLAIN QUERY PLAN ${query}`, ...bindings).toArray(),
      ),
    };
  }

  stats() {
    return storageStats(this.ctx.storage);
  }

  routing = routeByConfig(runtimeEnv, {
    routes: [
      {
        destination: "BENCHMARK_QUEUE",
        condition: { path: "$.benchmarkDestination", exact: "queue" },
      },
      {
        destination: "BENCHMARK_BUCKET",
        condition: { path: "$.benchmarkDestination", exact: "r2" },
      },
      {
        destination: "BENCHMARK_WORKFLOW",
        condition: { path: "$.benchmarkDestination", exact: "workflow" },
      },
    ],
  });
}

const failingQueue = {
  send: async () => {
    throw new Error("intentional benchmark delivery failure");
  },
  sendBatch: async () => {
    throw new Error("intentional benchmark delivery failure");
  },
  metrics: async () => ({ messages: 0 }),
} as unknown as Queue<EventPayload>;

type RetryEnv = {
  BENCHMARK_FAILING_QUEUE: Queue<EventPayload>;
};

export class RetryEventHub extends EventHub<RetryEnv> {
  private readonly ids = new MonotonicUlidGenerator();

  stats() {
    return storageStats(this.ctx.storage);
  }

  routing = routeFunc<RetryEnv>(
    { BENCHMARK_FAILING_QUEUE: failingQueue },
    () => [{ destination: "BENCHMARK_FAILING_QUEUE" }],
  );

  // Seed via the real persistence helper without scheduling automatic delivery.
  // This isolates the claim query used by alarm() from timer races and bindings.
  prepareClaims(count: number, finalized: boolean): number {
    const payloads = Array.from({ length: count }, (_, sequence) => ({
      sequence,
    }));
    const [first, ...rest] = payloads;
    const pending = createPendingDeliveryJobs(this.routing, [first, ...rest]);
    if (!pending.ok) throw new Error(pending.error.message);
    return this.ctx.storage.transactionSync(() => {
      const jobs = persistDeliveryJobs(
        this.ctx.storage.sql,
        pending.value,
        (now) => this.ids.generate(now),
      );
      if (finalized)
        markDeliveryJobsCompleted(
          this.ctx.storage.sql,
          jobs.map(({ id }) => id),
        );
      return jobs.length;
    });
  }

  processRetry(): number {
    return this.ctx.storage.transactionSync(() => {
      const lease = crypto.randomUUID();
      const claim = claimDeliverableJobs(
        this.ctx.storage.sql,
        1,
        lease,
        300_000,
      );
      markDeliveryJobsCompleted(
        this.ctx.storage.sql,
        claim.jobs.map(({ id }) => id),
        new Date(),
        lease,
      );
      return claim.jobs.length;
    });
  }
}

export class BenchmarkWorkflow extends WorkflowEntrypoint<
  BenchmarkEnv,
  EventPayload
> {
  async run(
    _event: WorkflowEvent<EventPayload>,
    _step: WorkflowStep,
  ): Promise<void> {}
}

const jsonError = (message: string, status: number): Response =>
  Response.json({ error: message }, { status });

const authorize = (request: Request): Response | undefined => {
  const expected = runtimeEnv.BENCHMARK_TOKEN;
  if (!expected) return jsonError("BENCHMARK_TOKEN is not configured", 503);
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return jsonError("unauthorized", 401);
  }
};

const parseInteger = (
  value: string | null,
  minimum: number,
  maximum: number,
): number | undefined => {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
};

const getHubName = (url: URL): string | undefined => {
  const name = url.searchParams.get("hub");
  return name !== null && HUB_NAME_PATTERN.test(name) ? name : undefined;
};

const getDestination = (url: URL): Destination | undefined => {
  const destination = url.searchParams.get("destination") ?? "none";
  return destination === "none" ||
    destination === "queue" ||
    destination === "r2" ||
    destination === "workflow"
    ? destination
    : undefined;
};

const readBody = async (request: Request): Promise<Record<string, unknown>> => {
  const body = await request.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("body must be a JSON object");
  }
  return body as Record<string, unknown>;
};

const getPadding = (url: URL): string | undefined => {
  const raw = url.searchParams.get("paddingBytes");
  if (raw === null) return "";
  const size = parseInteger(raw, 0, MAX_PADDING_BYTES);
  return size === undefined ? undefined : "x".repeat(size);
};

const publish = async (request: Request, url: URL): Promise<Response> => {
  const hubName = getHubName(url);
  const destination = getDestination(url);
  if (!hubName || !destination) return jsonError("invalid parameters", 400);

  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "invalid body",
      400,
    );
  }

  const result = await runtimeEnv.EVENT_HUB.getByName(hubName).publish({
    ...body,
    benchmarkDestination: destination,
  });
  return result.ok
    ? Response.json({ ok: true })
    : Response.json(result, { status: 500 });
};

const seed = async (url: URL): Promise<Response> => {
  const hubName = getHubName(url);
  const count = parseInteger(url.searchParams.get("count"), 1, MAX_BATCH_SIZE);
  const start = parseInteger(
    url.searchParams.get("start"),
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const padding = getPadding(url);
  if (
    !hubName ||
    count === undefined ||
    start === undefined ||
    padding === undefined
  ) {
    return jsonError("invalid parameters", 400);
  }

  const payloads: BenchmarkPayload[] = Array.from(
    { length: count },
    (_, i) => ({
      benchmarkDestination: "none",
      sequence: start + i,
      padding,
    }),
  );
  const [first, ...rest] = payloads;
  if (url.searchParams.get("claims") === "true") {
    const seeded = await runtimeEnv.RETRY_EVENT_HUB.getByName(
      hubName,
    ).prepareClaims(count, true);
    return Response.json({ ok: true, count: seeded });
  }
  const result = await runtimeEnv.EVENT_HUB.getByName(hubName).publish(
    first,
    ...rest,
  );
  return result.ok
    ? Response.json({ ok: true, count })
    : Response.json(result, { status: 500 });
};

const list = async (url: URL): Promise<Response> => {
  const hubName = getHubName(url);
  const max = parseInteger(url.searchParams.get("max") ?? "100", 1, 100);
  if (!hubName || max === undefined)
    return jsonError("invalid parameters", 400);
  const result = await runtimeEnv.EVENT_HUB.getByName(hubName).list({ max });
  if (!result.ok) return Response.json(result, { status: 500 });
  return Response.json({ ok: true, count: result.value.payloads.length });
};

type CleanupHub = Pick<BenchmarkEventHub, "eject" | "listEjected" | "evict">;

const cleanupBatch = async (
  hub: CleanupHub,
): Promise<{ removed: number; done: boolean }> => {
  const ejected = await hub.eject(Number.MAX_SAFE_INTEGER, { max: 100 });
  if (!ejected.ok) throw new Error(ejected.error.message);
  if (ejected.value.ejectKey === null) {
    return { removed: 0, done: true };
  }
  const page = await hub.listEjected(ejected.value.ejectKey, { max: 100 });
  if (!page.ok) throw new Error(page.error.message);
  const evicted = await hub.evict(ejected.value.ejectKey);
  if (!evicted.ok) throw new Error(evicted.error.message);
  return { removed: page.value.payloads.length, done: false };
};

const cleanup = async (url: URL): Promise<Response> => {
  const hubName = getHubName(url);
  if (!hubName) return jsonError("invalid parameters", 400);
  try {
    const [regular, retry] = await Promise.all([
      cleanupBatch(runtimeEnv.EVENT_HUB.getByName(hubName)),
      cleanupBatch(runtimeEnv.RETRY_EVENT_HUB.getByName(hubName)),
    ]);
    return Response.json({
      ok: true,
      removed: regular.removed + retry.removed,
      done: regular.done && retry.done,
    });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "cleanup failed",
      500,
    );
  }
};

const prepareRetry = async (url: URL): Promise<Response> => {
  const hubName = getHubName(url);
  const count = parseInteger(url.searchParams.get("count") ?? "1", 1, 100);
  if (!hubName || count === undefined)
    return jsonError("invalid parameters", 400);
  const prepared = await runtimeEnv.RETRY_EVENT_HUB.getByName(
    hubName,
  ).prepareClaims(count, false);
  return Response.json({ ok: true, count: prepared });
};

const processRetry = async (url: URL): Promise<Response> => {
  const hubName = getHubName(url);
  if (!hubName) return jsonError("invalid parameters", 400);
  const claimed =
    await runtimeEnv.RETRY_EVENT_HUB.getByName(hubName).processRetry();
  return Response.json({ ok: true, claimed });
};

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        compatibilityDate: "2026-09-11",
        cfEventhubVersion: "1.0.0-rc.0",
        colo: request.cf?.colo,
        clientCity: request.cf?.city,
        clientCountry: request.cf?.country,
      });
    }
    const unauthorized = authorize(request);
    if (unauthorized) return unauthorized;

    if (request.method === "POST" && url.pathname === "/cleanup-r2") {
      const page = await runtimeEnv.BENCHMARK_BUCKET.list({ limit: 1000 });
      if (page.objects.length > 0) {
        await runtimeEnv.BENCHMARK_BUCKET.delete(
          page.objects.map(({ key }) => key),
        );
      }
      return Response.json({
        ok: true,
        removed: page.objects.length,
        done: page.objects.length === 0,
      });
    }

    if (request.method === "POST" && url.pathname === "/publish") {
      return publish(request, url);
    }
    if (request.method === "POST" && url.pathname === "/seed") {
      return seed(url);
    }
    if (request.method === "GET" && url.pathname === "/list") {
      return list(url);
    }
    if (request.method === "GET" && url.pathname === "/stats") {
      const hubName = getHubName(url);
      if (!hubName) return jsonError("invalid parameters", 400);
      const namespace =
        url.searchParams.get("claims") === "true"
          ? runtimeEnv.RETRY_EVENT_HUB
          : runtimeEnv.EVENT_HUB;
      return Response.json(await namespace.getByName(hubName).stats());
    }
    if (request.method === "GET" && url.pathname === "/profile-list") {
      const hubName = getHubName(url);
      if (!hubName) return jsonError("invalid parameters", 400);
      return Response.json(
        await runtimeEnv.EVENT_HUB.getByName(hubName).profileList(),
      );
    }
    if (request.method === "DELETE" && url.pathname === "/cleanup") {
      return cleanup(url);
    }
    if (request.method === "POST" && url.pathname === "/retry/prepare") {
      return prepareRetry(url);
    }
    if (request.method === "POST" && url.pathname === "/retry/process") {
      return processRetry(url);
    }
    return jsonError("not found", 404);
  },

  queue(batch): void {
    batch.ackAll();
  },
} satisfies ExportedHandler<BenchmarkEnv>;
