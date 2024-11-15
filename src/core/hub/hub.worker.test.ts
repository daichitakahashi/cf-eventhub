import { assert, describe, expect, test } from "vitest";

import { EventSink } from ".";
import { DevRepository } from "../../dev/repository";
import { DefaultLogger } from "../logger";
import type { Repository } from "../repository";
import type { Config } from "./routing";
import type { QueueMessage } from "./queue";

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

describe("putEvent", () => {
  const route: Config = {
    routes: [
      {
        conditions: [
          {
            path: "$.like",
            exact: "culture",
          },
          {
            path: "$.avoidUrban",
            exact: false,
          },
        ],
        destination: "TOKYO",
        maxRetries: 11,
        delaySeconds: 11,
      },
      {
        conditions: [
          {
            path: "$.like",
            exact: "culture",
          },
        ],
        destination: "OKAYAMA",
        maxRetries: 33,
        delaySeconds: 33,
      },
      {
        conditions: [
          {
            path: "$.like",
            exact: "nature",
          },
        ],
        destination: "HOkKAIDO",
        maxRetries: 66,
        delaySeconds: 66,
      },
      {
        conditions: [
          {
            path: "$.like",
            exact: "nature",
          },
        ],
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
    const dispatches = await repo.listDispatches(100);
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
    const cultureEvent = await repo.getEvent(okayama?.eventId as string);
    assert(cultureEvent.isOk());
    expect(cultureEvent.value).toMatchObject({
      id: okayama?.eventId,
      payload: {
        like: "culture",
        avoidUrban: true,
      },
    });
    const natureEvent = await repo.getEvent(hokkaido?.eventId as string);
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
    const dispatches = await repo.listDispatches(100);
    assert(dispatches.isOk());
    expect(dispatches.value.list).toHaveLength(0);

    // Check sent messages.
    expect(queue.sentMessages).toHaveLength(0);
  });
});

describe("retryDispatch", () => {
  test("retryDispatch makes new dispatch", async () => {
    //
  });

  test("retry of ongoing dispatch causes error", async () => {});
});

// describe("markLostDispatches", () => {});
