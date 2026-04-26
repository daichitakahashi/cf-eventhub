import { safeTry } from "neverthrow";
import * as v from "valibot";
import { assert, describe, expect, test } from "vitest";

import { Dispatcher } from ".";
import { DevRepository } from "../../dev/repository";
import { DefaultLogger } from "../logger";
import { appendExecutionLog } from "../model";
import type { Repository } from "../repository";
import type { EventPayload } from "../type";
import type { Handler } from "./handler";

const handlerFunc = (fn: Handler["handle"]): Handler => ({
  handle: (p) => fn(p),
});

const Payload = v.object({
  expectedResult: v.union([
    v.literal("complete"),
    v.literal("failed"),
    v.literal("ignored"),
  ]),
});

describe("dispatch", () => {
  const defaultRetryDelay = { type: "exponential", base: 2, max: 20 } as const;
  const createMessage = (dispatchId: string) => ({
    dispatchId,
    retryDelay: defaultRetryDelay,
  });

  const createDispatch = async (
    repo: Repository,
    destination: string,
    payload: EventPayload,
  ) => {
    const createdEvent = await repo.mutate((tx) =>
      tx.createEvents([
        {
          payload,
          createdAt: new Date(),
        },
      ]),
    );
    assert(createdEvent.isOk());

    const createdDispatch = await repo.mutate((tx) =>
      tx.createDispatches([
        {
          eventId: createdEvent.value[0].id,
          destination,
          createdAt: new Date(),
          delaySeconds: 3,
          maxRetries: 2,
          retryDelay: { type: "exponential", base: 2, max: 20 },
        },
      ]),
    );
    assert(createdDispatch.isOk());
    return createdDispatch.value[0].id;
  };

  const env = {
    HANDLER: handlerFunc(async (payload) => {
      const { expectedResult } = v.parse(Payload, payload);
      return expectedResult;
    }),
    // NOT_FOUND_HANDLER: undefined
  };

  test("successful execution makes dispatch 'completed'", async () => {
    const repo = new DevRepository();
    const d = new Dispatcher(repo, env, new DefaultLogger("ERROR"));

    const dispatchId = await createDispatch(repo, "HANDLER", {
      expectedResult: "complete",
    });

    // Execute and check result.
    const result = await d.attemptDispatch(createMessage(dispatchId));
    expect(result).toMatchObject({
      type: "dispatched",
      result: "complete",
    });

    // Check dispatch status.
    const dispatch = await repo.mutate((tx) =>
      tx.getTargetDispatch(dispatchId),
    );
    assert(dispatch.isOk());
    expect(dispatch.value?.dispatch.status).toBe("complete");
  });

  test("not found dispatch causes dispatch 'notfound'", async () => {
    const repo = new DevRepository();
    const d = new Dispatcher(repo, env, new DefaultLogger("ERROR"));

    // Execute and check result.
    const result = await d.attemptDispatch(createMessage("not_found_dispatch"));
    expect(result).toMatchObject({
      type: "dispatched",
      result: "notfound",
    });
  });

  test("resulted dispatch causes dispatch 'notfound'", async () => {
    const repo = new DevRepository();
    const d = new Dispatcher(repo, env, new DefaultLogger("ERROR"));

    const dispatchId = await createDispatch(repo, "HANDLER", {
      expectedResult: "complete",
    });
    const createResult = await repo.mutate(async (tx) =>
      safeTry(async function* () {
        const createdDispatch = yield* await tx.getTargetDispatch(dispatchId);
        assert(createdDispatch?.dispatch.status === "ongoing");
        const completeDispatch = appendExecutionLog(createdDispatch.dispatch, {
          result: "complete",
          executedAt: new Date(),
        });
        return tx.saveDispatch(completeDispatch);
      }),
    );
    assert(createResult.isOk());

    // Execute and check result.
    const result = await d.attemptDispatch(createMessage(dispatchId));
    expect(result).toMatchObject({
      type: "dispatched",
      result: "notfound",
    });

    // Check dispatch status.
    const dispatch = await repo.mutate((tx) =>
      tx.getTargetDispatch(dispatchId),
    );
    assert(dispatch.isOk());
    expect(dispatch.value?.dispatch.status).toBe("complete");
  });

  test("rejection makes dispatch 'failed'", async () => {
    const repo = new DevRepository();
    const d = new Dispatcher(repo, env, new DefaultLogger("ERROR"));

    const dispatchId = await createDispatch(repo, "HANDLER", {
      onlyUnknownField: "unknown",
    });

    // Execute and check result.
    const result = await d.attemptDispatch(createMessage(dispatchId));
    expect(result).toMatchObject({
      type: "dispatched",
      result: "failed",
    });

    // Check dispatch status.
    const dispatch = await repo.mutate((tx) =>
      tx.getTargetDispatch(dispatchId),
    );
    assert(dispatch.isOk());
    expect(dispatch.value?.dispatch.status).toBe("ongoing"); // waiting for retry
  });

  test("max retried dispatch makes dispatch 'failed'", async () => {
    const repo = new DevRepository();
    const d = new Dispatcher(repo, env, new DefaultLogger("ERROR"));

    const dispatchId = await createDispatch(repo, "HANDLER", {
      expectedResult: "failed",
    });
    const retryDelay = { type: "constant", interval: 1 } as const;
    const msg = {
      dispatchId,
      retryDelay,
    };

    // Execute and check result.
    const firstAttempt = await d.attemptDispatch(msg);
    expect(firstAttempt).toMatchObject({
      type: "dispatched",
      result: "failed",
    });

    // First retry.
    const firstRetryResult = await d.attemptDispatch(
      msg,
      0,
      new Date(Date.now() + 1_100),
    );
    expect(firstRetryResult).toMatchObject({
      type: "dispatched",
      result: "failed",
    });

    // Second retry.
    const secondRetryResult = await d.attemptDispatch(
      msg,
      0,
      new Date(Date.now() + 2_200),
    );
    expect(secondRetryResult).toMatchObject({
      type: "dispatched",
      result: "failed",
    });

    // Check dispatch status.
    const dispatch = await repo.mutate((tx) =>
      tx.getTargetDispatch(dispatchId),
    );
    assert(dispatch.isOk());
    expect(dispatch.value?.dispatch.status).toBe("failed");

    // Retry after resulted dispatch.
    const afterExhaustedResult = await d.attemptDispatch(
      msg,
      0,
      new Date(Date.now() + 3_300),
    );
    expect(afterExhaustedResult).toMatchObject({
      type: "dispatched",
      result: "notfound",
    });
  });

  test("not found destination makes dispatch 'misconfigured'", async () => {
    const repo = new DevRepository();
    const d = new Dispatcher(repo, env, new DefaultLogger("ERROR"));

    const dispatchId = await createDispatch(repo, "NOT_FOUND_HANDLER", {
      expectedResult: "complete",
    });

    // Execute and check result.
    const result = await d.attemptDispatch(createMessage(dispatchId));
    expect(result).toMatchObject({
      type: "dispatched",
      result: "misconfigured",
    });

    // Check dispatch status.
    const dispatch = await repo.mutate((tx) =>
      tx.getTargetDispatch(dispatchId),
    );
    assert(dispatch.isOk());
    expect(dispatch.value?.dispatch.status).toBe("misconfigured");
  });

  test("payload will be put directly when the destination is a R2Bucket", async () => {
    // Create a mock R2Bucket.
    const bucketStore = new Map<string, unknown>();
    const bucket = {
      constructor: { name: "R2Bucket" },
      put: async (key: string, value: unknown): Promise<R2Object | null> => {
        bucketStore.set(key, value);
        return null;
      },
    } as unknown as R2Bucket;

    const repo = new DevRepository();
    const d = new Dispatcher(
      repo,
      {
        BUCKET: bucket,
      },
      new DefaultLogger("ERROR"),
    );

    const dispatchId = await createDispatch(repo, "BUCKET", {
      message: "This message is published via R2 bucket",
    });

    // Execute and check result.
    const result = await d.attemptDispatch(createMessage(dispatchId));
    expect(result).toMatchObject({
      type: "dispatched",
      result: "complete",
    });

    // Check dispatch status.
    const dispatch = await repo.mutate((tx) =>
      tx.getTargetDispatch(dispatchId),
    );
    assert(dispatch.isOk());
    expect(dispatch.value?.dispatch.status).toBe("complete");

    // Check put object.
    const putContent = bucketStore.values().next().value;
    expect(putContent).toEqual(
      `{"message":"This message is published via R2 bucket"}`,
    );
  });
});
