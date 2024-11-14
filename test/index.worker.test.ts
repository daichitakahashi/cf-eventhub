import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import {
  type ExportedHandler,
  type ExportedHandlerQueueHandler,
  type MessageSendRequest,
  type Queue,
  type QueueSendBatchOptions,
  type Request,
  Response,
} from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DefaultLogger } from "../src/core/logger";
import type { Config, QueueMessage } from "../src/core/type";
import { EventHub } from "../src/dev";

// テストの流れを確認してみる
// テストしたいこと
// - 確実に実行されること
// - 失敗してもリトライすること
// - 何度やってもダメだった場合、lost状態になること
// - 対応するハンドラーがなければ、misconfigured状態になること

// - リトライしつつ、必ず全部成功するテスト
// - リトライしつつ、全部失敗するテスト

// フローを分解してみる
// - まずは、プットイベントしたら、設定に従って適切にdispatchが作成され、その結果queueに追加される
//    - この段階では、キューに積まれたデータのみを確認すれば良い？dispatchIdしかわからないので、エンキューされたアイテム数の確認しかできない
// - enqueueされたジョブをexecutorに流し、リトライも含めて処理。

type QueueMessageBody = {
  id: string;
  timestamp: Date;
  attempts: number;
  body: QueueMessage;
  ack: () => void;
  retry: () => void;
};

const queueMock = (
  consume: ExportedHandlerQueueHandler,
  maxRetries = 3,
): { enqueue: (message: QueueMessage) => void; wait: () => Promise<void> } => {
  const messages: QueueMessageBody[] = [];
  let resolveWait: () => void;
  let waitPromise = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });

  const processMessages = async () => {
    while (messages.length > 0) {
      const message = messages.shift();
      if (message) {
        try {
          const batch: MessageBatch<QueueMessage> = {
            queue: "",
            messages: [message],
            ackAll: () => {},
            retryAll: message.retry,
          };
          await consume(batch, {}, createExecutionContext());
        } catch (_) {
          if (message.attempts < maxRetries) {
            message.attempts++;
            messages.push(message);
          }
        }
      }
    }
    resolveWait();
    waitPromise = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
  };

  return {
    enqueue: async (message: QueueMessage) => {
      const queueMessage: QueueMessageBody = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 0,
        body: message,
        ack: () => {},
        retry: () => {
          if (queueMessage.attempts < maxRetries) {
            queueMessage.attempts++;
            messages.push(queueMessage);
          }
        },
      };
      messages.push(queueMessage);
      processMessages();
    },
    wait: () => waitPromise,
  };
};

const prepareWorkers = () => {
  const p = {
    promise: Promise.resolve(),
  };
  type Env = {
    EVENTHUB: EventHub;
    EVENTHUB_QUEUE: Omit<Queue<QueueMessage>, "send">;
    EVENTHUB_ROUTING: string;
  };

  const producer: ExportedHandler<Env> = {
    async fetch(req: Request, env) {
      await env.EVENTHUB.putEvent([
        {
          //
        },
      ]);
      return new Response(null, { status: 200 });
    },
  };

  const env = {
    EVNTHUB: new EventHub(createExecutionContext(), {}),
  };

  const queue: Omit<Queue<QueueMessage>, "send"> = {
    async sendBatch(messages, _options) {
      p.promise = p.promise.then(() => {
        env.EVNTHUB.queue(
          createMessageBatch("", [
            {
              id: "1",
              timestamp: new Date(),
              attempts: 0,
              body: {
                dispatchId: "1",
              },
            },
          ]),
        );
      });
    },
  };

  return {
    wait: () => p.promise,
  };
};

describe("EventHub", () => {
  test("EventHub", () => {
    const ctx = createExecutionContext();
    const mockQueue = new MockQueue();
    const hub = new EventHub(ctx, {
      EVENTHUB_QUEUE: mockQueue,
      EVENTHUB_ROUTING: JSON.stringify(
        ((): Config => ({
          routes: [
            {
              conditions: [
                {
                  path: "$.type",
                  exact: "test",
                },
              ],
              destination: "HANDLER",
            },
          ],
          defaultMaxRetries: 5,
        }))(),
      ),
    });
    hub.putEvent([
      {
        id: "1",
        type: "test",
        payload: {},
      },
    ]);
    // Verify the message was added to the queue
    expect(mockQueue.messages.length).toBe(1);
  });
});
