import { assert, describe, expect, test } from "vitest";

import { EventSink } from ".";
import { DevRepository } from "../../dev/repository";
import { DefaultLogger } from "../logger";
import { appendExecutionLog, makeDispatchLost } from "../model";
import type { Repository } from "../repository";
import type { QueueMessage } from "./queue";
import type { Config } from "./routing";

class QueueMock implements Queue<QueueMessage> {
  private _sentMessages: {
    body: QueueMessage;
    delaySeconds?: number;
    contentType?: string;
  }[] = [];

  async send(message: QueueMessage, options?: QueueSendOptions): Promise<void> {
    this._sentMessages.push({
      body: message,
      delaySeconds: options?.delaySeconds,
      contentType: options?.contentType,
    });
  }

  async sendBatch(
    messages: Iterable<MessageSendRequest<QueueMessage>>,
    options?: QueueSendBatchOptions,
  ): Promise<void> {
    for (const message of messages) {
      this._sentMessages.push({
        body: message.body,
        delaySeconds: message.delaySeconds || options?.delaySeconds,
        contentType: message.contentType,
      });
    }
  }

  get sentMessages(): {
    body: QueueMessage;
    delaySeconds?: number;
    contentType?: string;
  }[] {
    return this._sentMessages;
  }
}

const executor =
  (route: Config, repo: Repository) =>
  async (fn: (e: EventSink) => Promise<void>) => {
    const queue = new QueueMock();
    const sink = new EventSink(repo, queue, route, new DefaultLogger("ERROR"));
    await fn(sink);
    return queue;
  };

const route: Config = {
  routes: [
    {
      condition: {
        allOf: [
          {
            path: "$.like",
            exact: "culture",
          },
          {
            path: "$.avoidUrban",
            exact: false,
          },
        ],
      },
      destination: "TOKYO",
      maxRetries: 11,
      delaySeconds: 11,
    },
    {
      condition: {
        path: "$.like",
        exact: "culture",
      },
      destination: "OKAYAMA",
      maxRetries: 33,
      delaySeconds: 33,
    },
    {
      condition: {
        path: "$.like",
        exact: "nature",
      },
      destination: "HOkKAIDO",
      maxRetries: 66,
      delaySeconds: 66,
    },
    {
      condition: {
        path: "$.like",
        exact: "nature",
      },
      destination: "OKINAWA",
    },
  ],
  defaultMaxRetries: 99,
  defaultDelaySeconds: 99,
};
type Message = {
  like: string;
  avoidUrban: boolean;
};

describe("putEvent", () => {
  test("putEvent makes dispatches", async () => {
    const repo = new DevRepository();
    const execute = executor(route, repo);

    const queue = await execute(async (sink) => {
      await sink.putEvent([
        {
          like: "culture",
          avoidUrban: true,
        },
        {
          like: "nature",
          avoidUrban: false,
        },
      ] as Message[]);
    });

    // Check stored dispatches.
    const dispatches = await repo.readDispatches(100);
    assert(dispatches.isOk());
    expect(dispatches.value.list).toHaveLength(3);
    const okayama = dispatches.value.list.find(
      (d) => d.destination === "OKAYAMA",
    );
    expect(okayama).toMatchObject({
      status: "ongoing",
      destination: "OKAYAMA",
      delaySeconds: 33,
      maxRetries: 33,
      executionLog: [],
    });
    const hokkaido = dispatches.value.list.find(
      (d) => d.destination === "HOkKAIDO",
    );
    expect(hokkaido).toMatchObject({
      status: "ongoing",
      destination: "HOkKAIDO",
      delaySeconds: 66,
      maxRetries: 66,
      executionLog: [],
    });
    const okinawa = dispatches.value.list.find(
      (d) => d.destination === "OKINAWA",
    );
    expect(okinawa).toMatchObject({
      eventId: hokkaido?.eventId,
      status: "ongoing",
      destination: "OKINAWA",
      delaySeconds: 99, // default delaySeconds
      maxRetries: 99, //  default maxRetries
      executionLog: [],
    });
    expect(dispatches.value.continuationToken).toBeUndefined();

    // Check sent messages.
    expect(queue.sentMessages).toHaveLength(3);
    const dispatchToOkayama = queue.sentMessages.find(
      (m) => m.body.dispatchId === okayama?.id,
    );
    expect(dispatchToOkayama).toMatchObject({
      body: {
        dispatchId: okayama?.id,
        delaySeconds: 33,
      },
      delaySeconds: 33,
    });
    const dispatchToHokkaido = queue.sentMessages.find(
      (m) => m.body.dispatchId === hokkaido?.id,
    );
    expect(dispatchToHokkaido).toMatchObject({
      body: {
        dispatchId: hokkaido?.id,
        delaySeconds: 66,
      },
      delaySeconds: 66,
    });
    const dispatchToOkinawa = queue.sentMessages.find(
      (m) => m.body.dispatchId === okinawa?.id,
    );
    expect(dispatchToOkinawa).toMatchObject({
      body: {
        dispatchId: okinawa?.id,
        delaySeconds: 99,
      },
      delaySeconds: 99,
    });

    // Check stored events
    const cultureEvent = await repo.readEvent(okayama?.eventId as string);
    assert(cultureEvent.isOk());
    expect(cultureEvent.value).toMatchObject({
      id: okayama?.eventId,
      payload: {
        like: "culture",
        avoidUrban: true,
      },
    });
    const natureEvent = await repo.readEvent(hokkaido?.eventId as string);
    assert(natureEvent.isOk());
    expect(natureEvent.value).toMatchObject({
      id: hokkaido?.eventId,
      payload: {
        like: "nature",
        avoidUrban: false,
      },
    });
  });

  test("putEvent makes no dispatches", async () => {
    const repo = new DevRepository();
    const execute = executor(route, repo);

    const queue = await execute(async (sink) => {
      await sink.putEvent([
        {
          like: "people",
          avoidUrban: false,
        },
      ] as Message[]);
    });

    // Check dispatches.
    const dispatches = await repo.readDispatches(100);
    assert(dispatches.isOk());
    expect(dispatches.value.list).toHaveLength(0);

    // Check sent messages.
    expect(queue.sentMessages).toHaveLength(0);
  });
});

describe("retryDispatch", () => {
  test("retryDispatch makes new dispatch", async () => {
    const repo = new DevRepository();
    const execute = executor(route, repo);

    await execute(async (sink) => {
      await sink.putEvent([
        {
          like: "culture",
          avoidUrban: true,
        },
      ] as Message[]);
    });

    const createdDispatches = await repo.readDispatches(100);
    assert(createdDispatches.isOk());
    expect(createdDispatches.value.list).toHaveLength(1);
    const createdDispatch = createdDispatches.value.list[0];
    assert(createdDispatch.status === "ongoing");

    // Make dispatch lost.
    const save = await repo.mutate((tx) =>
      tx.saveDispatch(makeDispatchLost(createdDispatch, new Date())),
    );
    assert(save.isOk());

    // Retry.
    const queue = await execute(async (sink) => {
      await sink.retryDispatch({
        dispatchId: createdDispatch.id,
      });
    });

    // Check retried dispatch.
    const dispatches = await repo.readDispatches(
      100,
      undefined,
      ["ongoing"],
      "CREATED_AT_DESC", // list in reversed order
    );
    assert(dispatches.isOk());
    expect(dispatches.value.list).toHaveLength(1);
    const retriedDispatch = dispatches.value.list[0];

    expect(retriedDispatch.id).not.toBe(createdDispatch.id);
    expect(retriedDispatch.eventId).toBe(createdDispatch.eventId);
    expect(retriedDispatch).toMatchObject({
      status: "ongoing",
      destination: "OKAYAMA",
      delaySeconds: 33,
      maxRetries: 33,
      executionLog: [],
    });

    // Check sent messages.
    queue.sentMessages.find((m) => m.body.dispatchId === retriedDispatch.id);
    expect(queue.sentMessages).toHaveLength(1);
    expect(queue.sentMessages[0]).toMatchObject({
      body: {
        dispatchId: retriedDispatch.id,
        delaySeconds: 33,
      },
      delaySeconds: 33,
    });
  });

  test("retry with override options", async () => {
    const repo = new DevRepository();
    const execute = executor(route, repo);

    await execute(async (sink) => {
      await sink.putEvent([
        {
          like: "culture",
          avoidUrban: true,
        },
      ] as Message[]);
    });

    const createdDispatches = await repo.readDispatches(100);
    assert(createdDispatches.isOk());
    expect(createdDispatches.value.list).toHaveLength(1);
    const createdDispatch = createdDispatches.value.list[0];
    assert(createdDispatch.status === "ongoing");

    // Make dispatch lost.
    const save = await repo.mutate((tx) =>
      tx.saveDispatch(makeDispatchLost(createdDispatch, new Date())),
    );
    assert(save.isOk());

    // Retry.
    const queue = await execute(async (sink) => {
      await sink.retryDispatch({
        dispatchId: createdDispatch.id,
        options: {
          delaySeconds: 777,
          maxRetries: 777,
        },
      });
    });

    // Check retried dispatch.
    const dispatches = await repo.readDispatches(
      100,
      undefined,
      ["ongoing"],
      "CREATED_AT_DESC", // list in reversed order
    );
    assert(dispatches.isOk());
    expect(dispatches.value.list).toHaveLength(1);
    const retriedDispatch = dispatches.value.list[0];

    expect(retriedDispatch.id).not.toBe(createdDispatch.id);
    expect(retriedDispatch.eventId).toBe(createdDispatch.eventId);
    expect(retriedDispatch).toMatchObject({
      status: "ongoing",
      destination: "OKAYAMA",
      delaySeconds: 777, // *
      maxRetries: 777, // *
      executionLog: [],
    });

    // Check sent messages.
    queue.sentMessages.find((m) => m.body.dispatchId === retriedDispatch.id);
    expect(queue.sentMessages).toHaveLength(1);
    expect(queue.sentMessages[0]).toMatchObject({
      body: {
        dispatchId: retriedDispatch.id,
        delaySeconds: 777, // *
      },
      delaySeconds: 777, // *
    });
  });

  test("retry of ongoing dispatch causes error", async () => {
    const repo = new DevRepository();
    const execute = executor(route, repo);

    await execute(async (sink) => {
      await sink.putEvent([
        {
          like: "culture",
          avoidUrban: true,
        },
      ] as Message[]);
    });

    const createdDispatches = await repo.readDispatches(100);
    assert(createdDispatches.isOk());
    expect(createdDispatches.value.list).toHaveLength(1);
    const createdDispatch = createdDispatches.value.list[0];
    assert(createdDispatch.status === "ongoing");

    // Retry.
    expect(
      execute(async (sink) => {
        await sink.retryDispatch({
          dispatchId: createdDispatch.id,
        });
      }),
    ).rejects.toThrowError();
  });
});

describe("markLostDispatches", () => {
  const route: Config = {
    routes: [
      {
        condition: {
          path: "$.wait",
          exact: 1,
        },
        destination: "BLACK_HOLE",
        delaySeconds: 1,
      },
      {
        condition: {
          path: "$.wait",
          exact: 2,
        },
        destination: "BLACK_HOLE",
        delaySeconds: 2,
      },
    ],
  };
  const sleepOneSec = (co?: number) =>
    new Promise((resolve) => setTimeout(resolve, 1000 * (co || 1)));

  test("no lost dispatches", async () => {
    const repo = new DevRepository();
    const sink = new EventSink(
      repo,
      new QueueMock(),
      route,
      new DefaultLogger("ERROR"),
    );

    await sink.putEvent([
      {
        wait: 1,
      },
    ]);

    // without sleep...

    const result = await sink.markLostDispatches({
      elapsedSeconds: 30,
    });
    expect(result.list).toHaveLength(0);
  });

  test("detect lost dispatch with no execution", async () => {
    const repo = new DevRepository();
    const sink = new EventSink(
      repo,
      new QueueMock(),
      route,
      new DefaultLogger("ERROR"),
    );

    await sink.putEvent([
      {
        wait: 1,
      },
    ]);

    const createdDispatches = await repo.readDispatches(100);
    assert(createdDispatches.isOk());
    expect(createdDispatches.value.list).toHaveLength(1);
    const createdDispatch = createdDispatches.value.list[0];
    assert(createdDispatch.status === "ongoing");

    // Sleep for delaySeconds
    await sleepOneSec(1.2);

    const first = await sink.markLostDispatches({
      elapsedSeconds: 1,
    });
    expect(first.list).toHaveLength(0);

    // Sleep for elapsedSeconds
    await sleepOneSec(1.2);

    const second = await sink.markLostDispatches({
      elapsedSeconds: 1,
    });
    expect(second.list).toHaveLength(1);
    expect(second.list[0]).toMatchObject({
      id: createdDispatch.id,
      status: "lost",
      destination: "BLACK_HOLE",
      delaySeconds: 1,
      maxRetries: 5,
      executionLog: [],
    });

    // Check ongoing dispatch is lost.
    const dispatches = await repo.readDispatches(100, undefined, ["ongoing"]);
    assert(dispatches.isOk());
    expect(dispatches.value.list).toHaveLength(0);
  });

  test("detect lost dispatch with failed execution", async () => {
    const repo = new DevRepository();
    const sink = new EventSink(
      repo,
      new QueueMock(),
      route,
      new DefaultLogger("ERROR"),
    );

    await sink.putEvent([
      {
        wait: 1,
      },
    ]);

    const createdDispatches = await repo.readDispatches(100);
    assert(createdDispatches.isOk());
    expect(createdDispatches.value.list).toHaveLength(1);
    const createdDispatch = createdDispatches.value.list[0];
    assert(createdDispatch.status === "ongoing");

    // Sleep for delaySeconds+elapsedSeconds
    await sleepOneSec(2);

    // Execute dispatch and fail.
    const executed = appendExecutionLog(createdDispatch, {
      result: "failed",
      executedAt: new Date(),
    });
    const saved = await repo.mutate((tx) => tx.saveDispatch(executed));
    assert(saved.isOk());

    // Sleep for delaySeconds.
    await sleepOneSec(1.2);

    // Not lost.
    const first = await sink.markLostDispatches({
      elapsedSeconds: 1,
    });
    expect(first.list).toHaveLength(0);

    // Sleep for elapsedSeconds
    await sleepOneSec(1.2);

    const second = await sink.markLostDispatches({
      elapsedSeconds: 1,
    });
    expect(second.list).toHaveLength(1);
    expect(second.list[0]).toMatchObject({
      id: createdDispatch.id,
      status: "lost",
      destination: "BLACK_HOLE",
      delaySeconds: 1,
      maxRetries: 5,
      executionLog: [
        {
          result: "failed",
        },
      ],
    });

    // Check ongoing dispatch is lost.
    const dispatches = await repo.readDispatches(100, undefined, ["ongoing"]);
    assert(dispatches.isOk());
    expect(dispatches.value.list).toHaveLength(0);
  });

  test("detect some lost dispatches using pagination", async () => {
    const repo = new DevRepository();
    const sink = new EventSink(
      repo,
      new QueueMock(),
      route,
      new DefaultLogger("ERROR"),
    );

    // Create dispatches.
    await sink.putEvent([{ wait: 1 }]);
    await sink.putEvent([{ wait: 2 }]);
    await sink.putEvent([{ wait: 1 }]);
    await sink.putEvent([{ wait: 2 }]);
    await sink.putEvent([{ wait: 2 }]);
    await sink.putEvent([{ wait: 2 }]);
    await sink.putEvent([{ wait: 1 }]);
    await sink.putEvent([{ wait: 2 }]);

    // Wait for lost of wait:1 dispatches.
    await sleepOneSec(2.2);

    // Mark lost dispatches.
    const first = await sink.markLostDispatches({
      maxItems: 3,
      elapsedSeconds: 1,
    });
    expect(first.list).toHaveLength(2);

    const second = await sink.markLostDispatches({
      maxItems: 3,
      elapsedSeconds: 1,
      continuationToken: first.continuationToken,
    });
    expect(second.list).toHaveLength(0);

    const third = await sink.markLostDispatches({
      maxItems: 3,
      elapsedSeconds: 1,
      continuationToken: second.continuationToken,
    });
    expect(third.list).toHaveLength(1);
    expect(third.continuationToken).toBeUndefined();
  });
});
