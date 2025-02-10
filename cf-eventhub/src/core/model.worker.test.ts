import { assert, describe, expect, test } from "vitest";

import {
  type NewDispatch,
  type OngoingDispatch,
  appendExecutionLog,
  makeDispatchLost,
} from "./model";
import type { EventPayload } from "./type";

const nextTime = async () => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return new Date();
};

const ongoingDispatch = (dispatch: NewDispatch, payload: EventPayload) =>
  ({
    ...dispatch,
    id: crypto.randomUUID(),
    status: "ongoing",
    payload,
    executionLog: [],
  }) as unknown as OngoingDispatch;

describe("appendExecutionLog", async () => {
  const eventId = crypto.randomUUID();
  const createdAt = await nextTime();
  const d = ongoingDispatch(
    {
      eventId,
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
    },
    {
      key: "value",
    },
  );

  test("complete after fail", async () => {
    const executedAt1 = await nextTime();
    const d1 = appendExecutionLog(d, {
      result: "failed",
      executedAt: executedAt1,
    });
    expect(d1).toMatchObject({
      eventId,
      status: "ongoing",
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt: executedAt1,
        },
      ],
    });

    assert(d1.status === "ongoing");

    const executedAt2 = await nextTime();
    const d2 = appendExecutionLog(d1, {
      result: "complete",
      executedAt: executedAt2,
    });
    expect(d2).toMatchObject({
      eventId,
      status: "complete",
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt: executedAt1,
        },
        {
          result: "complete",
          executedAt: executedAt2,
        },
      ],
      resultedAt: executedAt2,
    });
  });

  test("ignore", async () => {
    const executedAt1 = await nextTime();
    const d1 = appendExecutionLog(d, {
      result: "ignored",
      executedAt: executedAt1,
    });
    expect(d1).toMatchObject({
      eventId,
      status: "ignored",
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      payload: { key: "value" },
      executionLog: [
        {
          result: "ignored",
          executedAt: executedAt1,
        },
      ],
      resultedAt: executedAt1,
    });
  });

  test("misconfigured", async () => {
    const executedAt1 = await nextTime();
    const d1 = appendExecutionLog(d, {
      result: "misconfigured",
      executedAt: executedAt1,
    });
    expect(d1).toMatchObject({
      eventId,
      status: "misconfigured",
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      payload: { key: "value" },
      executionLog: [
        {
          result: "misconfigured",
          executedAt: executedAt1,
        },
      ],
      resultedAt: executedAt1,
    });
  });

  test("complete in last execution", async () => {
    // first execution
    const executedAt1 = await nextTime();
    const d1 = appendExecutionLog(d, {
      result: "failed",
      executedAt: executedAt1,
    });
    expect(d1).toMatchObject({
      eventId,
      status: "ongoing",
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt: executedAt1,
        },
      ],
    });

    assert(d1.status === "ongoing");

    // retry 1
    const executedAt2 = await nextTime();
    const d2 = appendExecutionLog(d1, {
      result: "failed",
      executedAt: executedAt2,
    });
    expect(d2).toMatchObject({
      eventId,
      status: "ongoing",
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt: executedAt1,
        },
        {
          result: "failed",
          executedAt: executedAt2,
        },
      ],
    });

    assert(d2.status === "ongoing");

    // retry 2
    const executedAt3 = await nextTime();
    const d3 = appendExecutionLog(d2, {
      result: "failed",
      executedAt: executedAt3,
    });
    expect(d3).toMatchObject({
      eventId,
      status: "ongoing",
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt: executedAt1,
        },
        {
          result: "failed",
          executedAt: executedAt2,
        },
        {
          result: "failed",
          executedAt: executedAt3,
        },
      ],
    });

    assert(d3.status === "ongoing");

    // retry 3
    const executedAt4 = await nextTime();
    const d4 = appendExecutionLog(d3, {
      result: "complete",
      executedAt: executedAt4,
    });
    expect(d4).toMatchObject({
      eventId,
      status: "complete",
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt: executedAt1,
        },
        {
          result: "failed",
          executedAt: executedAt2,
        },
        {
          result: "failed",
          executedAt: executedAt3,
        },
        {
          result: "complete",
          executedAt: executedAt4,
        },
      ],
      resultedAt: executedAt4,
    });
  });

  test("fail", async () => {
    // first execution
    const executedAt1 = await nextTime();
    const d1 = appendExecutionLog(d, {
      result: "failed",
      executedAt: executedAt1,
    });
    expect(d1).toMatchObject({
      eventId,
      status: "ongoing",
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt: executedAt1,
        },
      ],
    });

    assert(d1.status === "ongoing");

    // retry 1
    const executedAt2 = await nextTime();
    const d2 = appendExecutionLog(d1, {
      result: "failed",
      executedAt: executedAt2,
    });
    expect(d2).toMatchObject({
      eventId,
      status: "ongoing",
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt: executedAt1,
        },
        {
          result: "failed",
          executedAt: executedAt2,
        },
      ],
    });

    assert(d2.status === "ongoing");

    // retry 2
    const executedAt3 = await nextTime();
    const d3 = appendExecutionLog(d2, {
      result: "failed",
      executedAt: executedAt3,
    });
    expect(d3).toMatchObject({
      eventId,
      status: "ongoing",
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt: executedAt1,
        },
        {
          result: "failed",
          executedAt: executedAt2,
        },
        {
          result: "failed",
          executedAt: executedAt3,
        },
      ],
    });

    assert(d3.status === "ongoing");

    // retry 3
    const executedAt4 = await nextTime();
    const d4 = appendExecutionLog(d3, {
      result: "failed",
      executedAt: executedAt4,
    });
    expect(d4).toMatchObject({
      eventId,
      status: "failed",
      destination: "WORKER_A",
      createdAt,
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt: executedAt1,
        },
        {
          result: "failed",
          executedAt: executedAt2,
        },
        {
          result: "failed",
          executedAt: executedAt3,
        },
        {
          result: "failed",
          executedAt: executedAt4,
        },
      ],
      resultedAt: executedAt4,
    });
  });

  test("no retry complete", async () => {
    const eventId = crypto.randomUUID();
    const createdAt = await nextTime();
    const d = ongoingDispatch(
      {
        eventId,
        destination: "WORKER_A",
        createdAt,
        maxRetries: 0,
        delaySeconds: 5,
        retryDelay: { type: "exponential", base: 2, max: 20 },
      },
      {
        key: "value",
      },
    );

    const executedAt1 = await nextTime();
    const d1 = appendExecutionLog(d, {
      result: "complete",
      executedAt: executedAt1,
    });
    expect(d1).toMatchObject({
      eventId,
      status: "complete",
      destination: "WORKER_A",
      maxRetries: 0,
      delaySeconds: 5,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      createdAt,
      payload: { key: "value" },
      executionLog: [
        {
          result: "complete",
          executedAt: executedAt1,
        },
      ],
      resultedAt: executedAt1,
    });
  });

  test("no retry fail", async () => {
    const eventId = crypto.randomUUID();
    const createdAt = await nextTime();
    const d = ongoingDispatch(
      {
        eventId,
        destination: "WORKER_A",
        delaySeconds: 5,
        maxRetries: 0,
        retryDelay: { type: "exponential", base: 2, max: 20 },
        createdAt,
      },
      {
        key: "value",
      },
    );

    const executedAt1 = await nextTime();
    const d1 = appendExecutionLog(d, {
      result: "failed",
      executedAt: executedAt1,
    });
    expect(d1).toMatchObject({
      eventId,
      status: "failed",
      destination: "WORKER_A",
      delaySeconds: 5,
      maxRetries: 0,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      createdAt,
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt: executedAt1,
        },
      ],
      resultedAt: executedAt1,
    });
  });
});

describe("makeDispatchLost", async () => {
  const eventId = crypto.randomUUID();
  const createdAt = await nextTime();
  const d = ongoingDispatch(
    {
      eventId,
      destination: "WORKER_A",
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      createdAt,
    },
    {
      key: "value",
    },
  );

  test("lost without retry", async () => {
    const resultedAt = await nextTime();
    const d1 = makeDispatchLost(d, resultedAt);
    expect(d1).toMatchObject({
      eventId,
      status: "lost",
      destination: "WORKER_A",
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      createdAt,
      payload: { key: "value" },
      executionLog: [],
      resultedAt,
    });
  });

  test("lost after retry", async () => {
    const executedAt = await nextTime();
    const d1 = appendExecutionLog(d, {
      result: "failed",
      executedAt,
    });
    expect(d1).toMatchObject({
      eventId,
      status: "ongoing",
      destination: "WORKER_A",
      delaySeconds: 5,
      maxRetries: 3,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      createdAt,
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt,
        },
      ],
    });

    assert(d1.status === "ongoing");

    const resultedAt = await nextTime();
    const d2 = makeDispatchLost(d1, resultedAt);
    expect(d2).toMatchObject({
      eventId,
      status: "lost",
      destination: "WORKER_A",
      maxRetries: 3,
      delaySeconds: 5,
      retryDelay: { type: "exponential", base: 2, max: 20 },
      createdAt,
      payload: { key: "value" },
      executionLog: [
        {
          result: "failed",
          executedAt,
        },
      ],
      resultedAt,
    });
  });
});
