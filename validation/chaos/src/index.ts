import {
  DurableObject,
  env,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  configureDelivery,
  EventHub,
  type EventPayload,
  routeFunc,
} from "cf-eventhub";

type ChaosEnv = Env & { CHAOS_TOKEN: string };
const bindings = env as ChaosEnv;
type Mode = "pass" | "fail-before" | "commit-then-fail";
type Destination = "QUEUE" | "BUCKET" | "WORKFLOW";
type Config = { runId: string; seed: number; weights: Record<Mode, number> };
type Payload = EventPayload & {
  testRunId: string;
  eventIndex: number;
  __eventhub__: { deliveryJobId: string };
};
const modes: Mode[] = ["pass", "fail-before", "commit-then-fail"];
const destinations: Destination[] = ["QUEUE", "BUCKET", "WORKFLOW"];

export class FaultController extends DurableObject<ChaosEnv> {
  constructor(ctx: DurableObjectState, environment: ChaosEnv) {
    super(ctx, environment);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS config (singleton INTEGER PRIMARY KEY, body TEXT, enabled INTEGER, rng INTEGER)`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS decisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT, destination TEXT, jobIds TEXT, mode TEXT, outcome TEXT, at TEXT)`,
    );
  }
  setup(config: Config) {
    const weights = modes.map((mode) => config.weights[mode]);
    if (
      !Number.isInteger(config.seed) ||
      config.seed < 1 ||
      config.seed > 0xffffffff ||
      weights.some((w) => !Number.isFinite(w) || w <= 0)
    )
      throw new Error("Invalid seed or weights");
    if (this.ctx.storage.sql.exec("SELECT * FROM config").toArray().length)
      throw new Error("Run already exists; use a new runId");
    this.ctx.storage.sql.exec(
      "INSERT INTO config VALUES (1, ?, 1, ?)",
      JSON.stringify(config),
      config.seed,
    );
  }
  decide(destination: Destination, jobIds: string[]) {
    // No await: PRNG advancement and sequence allocation are one SQLite transaction.
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<{ body: string; enabled: number; rng: number }>(
          "SELECT * FROM config",
        )
        .one();
      const config: Config = JSON.parse(row.body);
      let rng = row.rng >>> 0;
      rng ^= rng << 13;
      rng ^= rng >>> 17;
      rng ^= rng << 5;
      rng >>>= 0;
      let mode: Mode = "pass";
      if (row.enabled) {
        let choice =
          (rng / 0x100000000) *
          modes.reduce((sum, m) => sum + config.weights[m], 0);
        for (const candidate of modes) {
          choice -= config.weights[candidate];
          if (choice < 0) {
            mode = candidate;
            break;
          }
        }
      }
      this.ctx.storage.sql.exec("UPDATE config SET rng = ?", rng);
      const { seq } = this.ctx.storage.sql
        .exec<{ seq: number }>(
          "INSERT INTO decisions (runId, destination, jobIds, mode, outcome, at) VALUES (?, ?, ?, ?, 'in-flight', ?) RETURNING seq",
          config.runId,
          destination,
          JSON.stringify(jobIds),
          mode,
          new Date().toISOString(),
        )
        .one();
      return { seq, mode };
    });
  }
  finish(seq: number, outcome: string) {
    this.ctx.storage.sql.exec(
      "UPDATE decisions SET outcome = ? WHERE seq = ? AND outcome = 'in-flight'",
      outcome,
      seq,
    );
  }
  disable() {
    this.ctx.storage.sql.exec("UPDATE config SET enabled = 0");
  }
  status() {
    return {
      config: this.ctx.storage.sql
        .exec("SELECT body, enabled FROM config")
        .toArray(),
      coverage: this.ctx.storage.sql
        .exec(
          "SELECT destination, mode, outcome, COUNT(*) AS count FROM decisions GROUP BY destination, mode, outcome",
        )
        .toArray(),
      decisions: this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS count FROM decisions")
        .one().count,
    };
  }
  log(after: number) {
    return this.ctx.storage.sql
      .exec(
        "SELECT * FROM decisions WHERE seq > ? ORDER BY seq LIMIT 100",
        after,
      )
      .toArray();
  }
}

export class ReceiptLedger extends DurableObject<ChaosEnv> {
  constructor(ctx: DurableObjectState, environment: ChaosEnv) {
    super(ctx, environment);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS receipts (runId TEXT, deliveryJobId TEXT, destination TEXT, instanceId TEXT, count INTEGER, PRIMARY KEY (runId, deliveryJobId, destination, instanceId))`,
    );
  }
  record(payload: Payload, destination: "QUEUE" | "WORKFLOW", instanceId = "") {
    if (!payload.testRunId || !payload.__eventhub__?.deliveryJobId)
      throw new Error("Missing delivery metadata");
    this.ctx.storage.sql.exec(
      `INSERT INTO receipts VALUES (?, ?, ?, ?, 1) ON CONFLICT (runId, deliveryJobId, destination, instanceId) DO UPDATE SET count = count + 1`,
      payload.testRunId,
      payload.__eventhub__.deliveryJobId,
      destination,
      instanceId,
    );
  }
  snapshot() {
    return this.ctx.storage.sql
      .exec("SELECT * FROM receipts ORDER BY destination, deliveryJobId")
      .toArray();
  }
}

async function inject<T>(
  destination: Destination,
  payloads: Payload[],
  call: () => Promise<T>,
  accepted: (result: T) => boolean = () => true,
): Promise<T> {
  const runId = payloads[0].testRunId;
  if (payloads.some((p) => p.testRunId !== runId))
    throw new Error("Mixed runs in handoff");
  const controller = bindings.FAULTS.getByName(runId);
  const { seq, mode } = await controller.decide(
    destination,
    payloads.map((p) => p.__eventhub__.deliveryJobId),
  );
  if (mode === "fail-before") {
    await controller.finish(seq, "injected");
    throw new Error(`chaos ${destination} fail-before #${seq}`);
  }
  let result: T;
  try {
    result = await call();
  } catch (error) {
    await controller.finish(seq, "destination-error");
    throw error;
  }
  if (mode === "commit-then-fail") {
    // Workflow createBatch can return only errors. Count coverage only when it
    // actually created an instance, not when a repeated ID was rejected.
    await controller.finish(
      seq,
      accepted(result) ? "injected" : "no-new-commit",
    );
    throw new Error(`chaos ${destination} commit-then-fail #${seq}`);
  }
  await controller.finish(seq, "passed");
  return result;
}

// Proxy only the fault boundary; bind every other method to its real receiver.
function wrap<T extends object, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K],
): T {
  return new Proxy(target, {
    get(object, property) {
      if (property === key) return replacement;
      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}
function wrapBindings() {
  return {
    QUEUE: wrap(bindings.QUEUE, "sendBatch", (messages, options) => {
      const batch = Array.from(messages);
      return inject(
        "QUEUE",
        batch.map((m) => m.body as Payload),
        () => bindings.QUEUE.sendBatch(batch, options),
      );
    }),
    BUCKET: wrap(bindings.BUCKET, "put", ((
      key: string,
      value: string,
      options?: R2PutOptions,
    ) =>
      inject("BUCKET", [JSON.parse(value) as Payload], () =>
        bindings.BUCKET.put(key, value, options),
      )) as R2Bucket["put"]),
    WORKFLOW: wrap(bindings.WORKFLOW, "createBatch", ((batch: {
      instances: WorkflowInstanceCreateOptions<Readonly<Payload>>[];
    }) =>
      inject(
        "WORKFLOW",
        batch.instances.map((i) => i.params as Payload),
        () => bindings.WORKFLOW.createBatch(batch),
        (result) => result.created.length > 0,
      )) as typeof bindings.WORKFLOW.createBatch),
  };
}

export class ChaosEventHub extends EventHub<ChaosEnv> {
  protected deliveryConfig = configureDelivery({
    includeDeliveryMetadata: true,
    initialRetryDelayMs: 1000,
    maxRetryDelayMs: 5000,
    maxDeliveryRetries: 1000,
    alarmBatchSize: 100,
    deliveryAttemptLeaseMs: 30000,
  });
  routing = routeFunc(
    wrapBindings(),
    () => destinations.map((destination) => ({ destination })),
    {
      r2: {
        BUCKET: {
          objectKey: ({ payload, deliveryJobId }) =>
            `chaos/${payload.testRunId}/${deliveryJobId}.json`,
        },
      },
    },
  );
  snapshot() {
    return {
      payloads: this.ctx.storage.sql
        .exec("SELECT id, body FROM payloads ORDER BY id")
        .toArray(),
      jobs: this.ctx.storage.sql
        .exec(
          "SELECT id, payload_id AS payloadId, destination, final_status AS finalStatus, retry_count AS retryCount, lease_token AS leaseToken, next_retry_at AS nextRetryAt, last_error AS lastError FROM delivery_jobs ORDER BY id",
        )
        .toArray(),
    };
  }
}

export class ReceiptWorkflow extends WorkflowEntrypoint<ChaosEnv, Payload> {
  async run(event: WorkflowEvent<Payload>, step: WorkflowStep) {
    await step.do("record independent execution receipt", async () => {
      await this.env.RECEIPTS.getByName(event.payload.testRunId).record(
        event.payload,
        "WORKFLOW",
        event.instanceId,
      );
    });
  }
}

export default {
  async fetch(request) {
    if (
      !bindings.CHAOS_TOKEN ||
      request.headers.get("authorization") !== `Bearer ${bindings.CHAOS_TOKEN}`
    )
      return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    const runId = url.searchParams.get("runId");
    if (!runId || !/^[a-zA-Z0-9_-]{1,80}$/.test(runId))
      return new Response("Invalid runId", { status: 400 });
    const controller = bindings.FAULTS.getByName(runId);
    const hub = bindings.HUB.getByName(`chaos-test-${runId}`);
    try {
      if (request.method === "POST" && url.pathname === "/setup") {
        await controller.setup({ ...(await request.json<Config>()), runId });
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/publish") {
        const { start, count } = await request.json<{
          start: number;
          count: number;
        }>();
        if (
          !Number.isInteger(start) ||
          start < 0 ||
          !Number.isInteger(count) ||
          count < 1 ||
          count > 100
        )
          throw new Error("Invalid publish batch");
        const [first, ...rest] = Array.from({ length: count }, (_, i) => ({
          testRunId: runId,
          eventIndex: start + i,
        }));
        const result = await hub.publish(first, ...rest);
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/disable") {
        await controller.disable();
        return Response.json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/state")
        return Response.json({
          hub: await hub.snapshot(),
          faults: await controller.status(),
          receipts: await bindings.RECEIPTS.getByName(runId).snapshot(),
        });
      if (request.method === "GET" && url.pathname === "/decisions")
        return Response.json(
          await controller.log(Number(url.searchParams.get("after") ?? 0)),
        );
      if (request.method === "GET" && url.pathname === "/objects") {
        const page = await bindings.BUCKET.list({
          prefix: `chaos/${runId}/`,
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: 100,
        });
        const objects = await Promise.all(
          page.objects.map(async ({ key }) => ({
            key,
            payload: await (await bindings.BUCKET.get(key))?.json(),
          })),
        );
        return Response.json({
          objects,
          cursor: page.truncated ? page.cursor : undefined,
        });
      }
      if (request.method === "POST" && url.pathname === "/workflows") {
        const ids = await request.json<string[]>();
        if (
          !Array.isArray(ids) ||
          ids.length > 20 ||
          ids.some((id) => !/^[0-9A-Z]{26}$/.test(id))
        )
          throw new Error("Invalid workflow IDs");
        return Response.json(
          await Promise.all(
            ids.map(async (id) => {
              try {
                const instance = await bindings.WORKFLOW.get(id);
                return {
                  id: instance.id,
                  status: (await instance.status()).status,
                };
              } catch (error) {
                return { id, error: String(error) };
              }
            }),
          ),
        );
      }
      if (request.method === "POST" && url.pathname === "/cleanup-r2") {
        const page = await bindings.BUCKET.list({ limit: 1000 });
        if (page.objects.length)
          await bindings.BUCKET.delete(page.objects.map((o) => o.key));
        return Response.json({
          removed: page.objects.length,
          done: !page.truncated,
        });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
  async queue(batch) {
    for (const message of batch.messages) {
      const payload = message.body as Payload;
      await bindings.RECEIPTS.getByName(payload.testRunId).record(
        payload,
        "QUEUE",
      );
      message.ack();
    }
  },
} satisfies ExportedHandler<ChaosEnv>;
