import { assert, expect } from "vitest";

import { err } from "neverthrow";
import type { Repository } from "../core/repository";

/*
シナリオ1: ロールバック
イベントの作成、ディスパッチの作成を行い、最後にエラーを返した後で、ディスパッチ・イベントの取得を行い、nullが返るのを確認する

シナリオ2: 実行記録の保存
イベント、ディスパッチを作成し、実行記録を保存する
*/

/** @internal */
export const testRepositoryRollback = async (
  repo: Repository,
  mode: "RESULT" | "THROW",
) => {
  let dispatchId: string | undefined;

  const result = await repo.enterTransactionalScope(async (tx) => {
    // Create events in transaction.
    const createdEvent = await (async () => {
      const eventPayload = {
        object: {
          field1: 99,
          field2: "AA",
          field3: true,
        },
        list: [1, 2, 3],
      };
      const createdAt = new Date();

      const result = await tx.createEvents([
        {
          payload: eventPayload,
          createdAt: createdAt,
        },
        {
          payload: { key: "value" },
          createdAt: createdAt,
        },
      ]);
      assert(result.isOk(), "createEvents must be succeeded");

      expect(result.value).toStrictEqual([
        {
          id: expect.any(String),
          payload: eventPayload,
          createdAt: expect.any(Date),
        },
        {
          id: expect.any(String),
          payload: { key: "value" },
          createdAt: expect.any(Date),
        },
      ]);

      return result.value[0];
    })();

    // Create dispatches for the event.
    const createdDispatch = await (async () => {
      const createdAt = new Date();
      const result = await tx.createDispatches([
        {
          eventId: createdEvent.id,
          destination: "WORKER_1",
          createdAt,
          delaySeconds: null,
          maxRetryCount: 5,
        },
        {
          eventId: createdEvent.id,
          destination: "WORKER_2",
          createdAt,
          delaySeconds: 5,
          maxRetryCount: 10,
        },
      ]);
      assert(result.isOk(), "createDispatches must be succeeded");

      expect(result.value).toStrictEqual([
        {
          eventId: createdEvent.id,
          destination: "WORKER_1",
          createdAt: expect.any(Date),
          delaySeconds: null,
          maxRetryCount: 5,
        },
        {
          eventId: createdEvent.id,
          destination: "WORKER_2",
          createdAt: expect.any(Date),
          delaySeconds: 5,
          maxRetryCount: 10,
        },
      ]);

      return result.value[0];
    })();

    dispatchId = createdDispatch.id;

    // Resulted as error
    if (mode === "RESULT") {
      return err("INTENDED_ERROR");
    }
    throw new Error("internal server error");
  });

  // Check transaction returns error.
  assert(result.isErr(), "enterTransactionalScope must be failed");
  if (mode === "RESULT") {
    expect(result.error).toBe("INTENDED_ERROR");
  } else {
    expect(result.error).toBe("INTERNAL_SERVER_ERROR");
  }

  // Check created event and dispatch disappeared.
  assert(!!dispatchId);
  const getResult = await repo.getDispatch(dispatchId);
  assert(getResult.isOk(), "getResult must be succeeded");
  expect(getResult.value).toBeNull();
};
