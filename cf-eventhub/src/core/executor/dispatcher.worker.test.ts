import * as v from "valibot";
import { assert, describe, expect, test } from "vitest";

import { Dispatcher } from ".";
import { DevRepository } from "../../dev/repository";
import { DefaultLogger } from "../logger";
import { appendExecutionLog } from "../model";
import type { Repository } from "../repository";
import type { EventPayload } from "../type";
import { type Handler, handler } from "./handler";

const handlerFunc = (fn: Handler["handle"]): Handler => ({
  [handler]: true,
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
  const createDispatch = async (
    repo: Repository,
    destination: string,
    payload: EventPayload,
  ) => {
    const createdEvent = await repo.createEvents([
      {
        payload,
        createdAt: new Date(),
      },
    ]);
    assert(createdEvent.isOk());

    const createdDispatch = await repo.createDispatches([
      {
        eventId: createdEvent.value[0].id,
        destination,
        createdAt: new Date(),
        delaySeconds: null,
        maxRetries: 2,
      },
    ]);
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
    const result = await d.dispatch({
      dispatchId,
    });
    expect(result).toBe("complete");

    // Check dispatch status.
    const dispatch = await repo.getDispatch(dispatchId);
    assert(dispatch.isOk());
    expect(dispatch.value?.dispatch.status).toBe("complete");
  });

  test("not found dispatch causes dispatch 'notfound'", async () => {
    const repo = new DevRepository();
    const d = new Dispatcher(repo, env, new DefaultLogger("ERROR"));

    // Execute and check result.
    const result = await d.dispatch({
      dispatchId: "not_found_dispatch",
    });
    expect(result).toBe("notfound");
  });

  test("resulted dispatch causes dispatch 'notfound'", async () => {
    const repo = new DevRepository();
    const d = new Dispatcher(repo, env, new DefaultLogger("ERROR"));

    const dispatchId = await createDispatch(repo, "HANDLER", {
      expectedResult: "complete",
    });
    const createdDispatch = await repo.getDispatch(dispatchId);
    assert(
      createdDispatch.isOk() &&
        createdDispatch.value?.dispatch.status === "ongoing",
    );
    const completeDispatch = appendExecutionLog(
      createdDispatch.value.dispatch,
      {
        result: "complete",
        executedAt: new Date(),
      },
    );
    const completed = await repo.saveDispatch(completeDispatch);
    assert(completed.isOk());

    // Execute and check result.
    const result = await d.dispatch({
      dispatchId,
    });
    expect(result).toBe("notfound");

    // Check dispatch status.
    const dispatch = await repo.getDispatch(dispatchId);
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
    const result = await d.dispatch({
      dispatchId,
    });
    expect(result).toBe("failed");

    // Check dispatch status.
    const dispatch = await repo.getDispatch(dispatchId);
    assert(dispatch.isOk());
    expect(dispatch.value?.dispatch.status).toBe("ongoing"); // waiting for retry
  });

  test("max retried dispatch makes dispatch 'failed'", async () => {
    const repo = new DevRepository();
    const d = new Dispatcher(repo, env, new DefaultLogger("ERROR"));

    const dispatchId = await createDispatch(repo, "HANDLER", {
      expectedResult: "failed",
    });

    // Execute and check result.
    const result = await d.dispatch({
      dispatchId,
    });
    expect(result).toBe("failed");

    // First retry.
    const firstRetryResult = await d.dispatch({
      dispatchId,
    });
    expect(firstRetryResult).toBe("failed");

    // Last retry.
    const lastRetry = await d.dispatch({
      dispatchId,
    });
    expect(lastRetry).toBe("failed");

    // Check dispatch status.
    const dispatch = await repo.getDispatch(dispatchId);
    assert(dispatch.isOk());
    expect(dispatch.value?.dispatch.status).toBe("failed");

    // Extra retry.
    const extraResult = await d.dispatch({
      dispatchId,
    });
    expect(extraResult).toBe("notfound");
  });

  test("not found destination makes dispatch 'misconfigured'", async () => {
    const repo = new DevRepository();
    const d = new Dispatcher(repo, env, new DefaultLogger("ERROR"));

    const dispatchId = await createDispatch(repo, "NOT_FOUND_HANDLER", {
      expectedResult: "complete",
    });

    // Execute and check result.
    const result = await d.dispatch({
      dispatchId,
    });
    expect(result).toBe("misconfigured");

    // Check dispatch status.
    const dispatch = await repo.getDispatch(dispatchId);
    assert(dispatch.isOk());
    expect(dispatch.value?.dispatch.status).toBe("misconfigured");
  });
});