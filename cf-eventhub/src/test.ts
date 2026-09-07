import { env } from "cloudflare:workers";
import { EventHub } from ".";
import { QueueMock, R2BucketMock } from "./core/mock";
import { routeByConfig, routeFunc } from "./core/routing";
import {
  type EvictionConfig,
  configureDelivery,
  configureEviction,
} from "./eventhub";

type Env = {
  OKAYAMA: Queue;
  HOKKAIDO: Queue;
  OKINAWA: Queue;
  ARCHIVE: R2Bucket;
  EVICTION_ARCHIVE: R2Bucket;
};

export const testRouting = routeByConfig<Env>(env as unknown as Env, {
  routes: [
    {
      condition: {
        path: "$.kind",
        exact: "culture",
      },
      destination: "OKAYAMA",
    },
    {
      condition: {
        path: "$.kind",
        exact: "nature",
      },
      destination: "HOKKAIDO",
    },
    {
      condition: {
        path: "$.kind",
        exact: "nature",
      },
      destination: "OKINAWA",
    },
    {
      condition: {
        path: "$.kind",
        exact: "archive",
      },
      destination: "ARCHIVE",
    },
  ],
});

export class TestEventHub extends EventHub<Env> {
  deliveryConfig = configureDelivery({});
  routing = testRouting;
}

export class TestEventHubWithDeleteEviction extends EventHub<Env> {
  deliveryConfig = configureDelivery({});
  eviction: EvictionConfig | undefined = configureEviction({
    afterMs: 1_000,
    action: { type: "delete" },
    batchSize: 2,
  });
  routing = testRouting;
}

export class TestEventHubWithArchiveEviction extends EventHub<Env> {
  deliveryConfig = configureDelivery({});
  eviction: EvictionConfig | undefined = configureEviction({
    afterMs: 1_000,
    action: {
      type: "archive",
      bucket: (env as unknown as Env).EVICTION_ARCHIVE,
      prefix: "automatic",
    },
    batchSize: 2,
  });
  routing = testRouting;
}

export class TestEventHubWithFailingArchiveEviction extends EventHub<Env> {
  bucket = new R2BucketMock([], true);
  deliveryConfig = configureDelivery({});
  eviction: EvictionConfig | undefined = configureEviction({
    afterMs: 1_000,
    action: {
      type: "archive",
      bucket: this.bucket as unknown as R2Bucket,
      prefix: "automatic-failure",
    },
    batchSize: 2,
  });
  routing = testRouting;
}

type EnvForTestEventHubWithJobId = {
  QUEUE: Queue;
  BUCKET: R2Bucket;
};

export class TestEventHubWithJobId extends EventHub<EnvForTestEventHubWithJobId> {
  deliveryConfig = configureDelivery({ includeDeliveryJobId: true });
  queue = new QueueMock();
  bucket = new R2BucketMock();
  routing = routeFunc<EnvForTestEventHubWithJobId>(
    {
      QUEUE: this.queue,
      BUCKET: this.bucket,
    },
    (e) => {
      const typ = e.type;
      if (typ === "queue")
        return [
          {
            destination: "QUEUE",
          },
        ];
      if (typ === "archive")
        return [
          {
            destination: "BUCKET",
          },
        ];
      return [];
    },
  );
}

export default {};
