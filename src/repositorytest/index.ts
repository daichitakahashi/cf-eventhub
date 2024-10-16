import { err, ok, safeTry } from "neverthrow";
import { assert, expect } from "vitest";

import { appendExecutionLog, makeDispatchLost } from "../core/model";
import type { Repository } from "../core/repository";

const eventPayload = {
  uuid: crypto.randomUUID(),
  timestamp: Date.now(),
};

// Create event and dispatch.
const createEvent = (repo: Repository) =>
  repo.enterTransactionalScope(
    async (tx) =>
      await safeTry(async function* () {
        // Create events.
        const eventCreatedAt = new Date();
        const [createdEvent] = yield* (
          await tx.createEvents([
            {
              payload: eventPayload,
              createdAt: eventCreatedAt,
            },
            {
              payload: { key: "value" },
              createdAt: eventCreatedAt,
            },
          ])
        ).safeUnwrap();

        const dispatchesCreatedAt = new Date();
        const created = yield* (
          await tx.createDispatches([
            {
              eventId: createdEvent.id,
              destination: "WORKER_1",
              createdAt: dispatchesCreatedAt,
              delaySeconds: null,
              maxRetries: 5,
            },
            {
              eventId: createdEvent.id,
              destination: "WORKER_2",
              createdAt: dispatchesCreatedAt,
              delaySeconds: 5,
              maxRetries: 10,
            },
          ])
        ).safeUnwrap();
        const createdDispatch = created.find(
          ({ destination }) => destination === "WORKER_1",
        );
        assert(createdDispatch !== undefined);

        return ok({ eventId: createdEvent.id, dispatchId: createdDispatch.id });
      }),
  );

// Execute dispatch and record its failure.
const dispatchFailed = (repo: Repository, dispatchId: string) =>
  repo.enterTransactionalScope(
    async (tx) =>
      await safeTry(async function* () {
        const got = yield* (await tx.getDispatch(dispatchId)).safeUnwrap();
        assert(got !== null);
        const dispatch = got.dispatch;
        assert(dispatch.status === "ongoing");

        const failed = appendExecutionLog(dispatch, {
          result: "failed",
          executedAt: new Date(),
        });

        return tx.saveDispatch(failed);
      }),
  );

/** @internal */
export const testRepositoryPersistsCompleteDispatch = async (
  repo: Repository,
) => {
  // Max retry count is 5.
  // Fail 5 times and complete.
  const got = await safeTry(async function* () {
    const { dispatchId } = yield* (await createEvent(repo)).safeUnwrap();

    // Fail 4 times.
    for (const _ of [...Array(5)]) {
      yield* (await dispatchFailed(repo, dispatchId)).safeUnwrap();
    }

    // Complete
    const got = yield* (await repo.getDispatch(dispatchId)).safeUnwrap();
    assert(got !== null);
    const { dispatch } = got;
    assert(dispatch.status === "ongoing");

    yield* (
      await repo.saveDispatch(
        appendExecutionLog(dispatch, {
          result: "complete",
          executedAt: new Date(),
        }),
      )
    ).safeUnwrap();

    return await repo.getDispatch(dispatchId);
  });
  assert(got.isOk());
  assert(got.value !== null);
  const { event, dispatch } = got.value;

  expect(event).toMatchObject({
    id: expect.any(String),
    payload: eventPayload,
    createdAt: expect.any(Date),
  });

  // Dispatch is executed 6 times(first try and 5 retries).
  expect(dispatch).toMatchObject({
    id: expect.any(String),
    eventId: event.id,
    status: "complete",
    destination: "WORKER_1",
    createdAt: expect.any(Date),
    delaySeconds: null,
    maxRetries: 5,
    executionLog: [
      {
        id: expect.any(String),
        result: "failed",
        executedAt: expect.any(Date),
      },
      {
        id: expect.any(String),
        result: "failed",
        executedAt: expect.any(Date),
      },
      {
        id: expect.any(String),
        result: "failed",
        executedAt: expect.any(Date),
      },
      {
        id: expect.any(String),
        result: "failed",
        executedAt: expect.any(Date),
      },
      {
        id: expect.any(String),
        result: "failed",
        executedAt: expect.any(Date),
      },
      {
        id: expect.any(String),
        result: "complete",
        executedAt: expect.any(Date),
      },
    ],
  });
};

/** @internal */
export const testRepositoryPersistsFailedDispatch = async (
  repo: Repository,
) => {
  // Max retry count is 5.
  // Fail 6 times.
  const got = await safeTry(async function* () {
    const { dispatchId } = yield* (await createEvent(repo)).safeUnwrap();

    // Fail 6 times.
    for (const _ of [...Array(6)]) {
      yield* (await dispatchFailed(repo, dispatchId)).safeUnwrap();
    }

    return await repo.getDispatch(dispatchId);
  });
  assert(got.isOk());
  assert(got.value !== null);
  const { event, dispatch } = got.value;

  expect(event).toMatchObject({
    id: expect.any(String),
    payload: eventPayload,
    createdAt: expect.any(Date),
  });

  // Dispatch is executed 6 times(first try and 5 retries).
  expect(dispatch).toMatchObject({
    id: expect.any(String),
    eventId: event.id,
    status: "failed",
    destination: "WORKER_1",
    createdAt: expect.any(Date),
    delaySeconds: null,
    maxRetries: 5,
    executionLog: [
      {
        id: expect.any(String),
        result: "failed",
        executedAt: expect.any(Date),
      },
      {
        id: expect.any(String),
        result: "failed",
        executedAt: expect.any(Date),
      },
      {
        id: expect.any(String),
        result: "failed",
        executedAt: expect.any(Date),
      },
      {
        id: expect.any(String),
        result: "failed",
        executedAt: expect.any(Date),
      },
      {
        id: expect.any(String),
        result: "failed",
        executedAt: expect.any(Date),
      },
      {
        id: expect.any(String),
        result: "failed",
        executedAt: expect.any(Date),
      },
    ],
  });
};

/** @internal */
export const testRepositoryPersistsIgnoredDispatch = async (
  repo: Repository,
) => {
  const got = await safeTry(async function* () {
    const { dispatchId } = yield* (await createEvent(repo)).safeUnwrap();

    const got = yield* (await repo.getDispatch(dispatchId)).safeUnwrap();
    assert(got !== null);
    const { dispatch } = got;
    assert(dispatch.status === "ongoing");

    const ignored = appendExecutionLog(dispatch, {
      result: "ignored",
      executedAt: new Date(),
    });
    yield* (await repo.saveDispatch(ignored)).safeUnwrap();

    return await repo.getDispatch(dispatchId);
  });
  assert(got.isOk());
  assert(got.value !== null);
  const { event, dispatch } = got.value;

  expect(event).toMatchObject({
    id: expect.any(String),
    payload: eventPayload,
    createdAt: expect.any(Date),
  });

  // Dispatch is ignored in first try.
  expect(dispatch).toMatchObject({
    id: expect.any(String),
    eventId: event.id,
    status: "ignored",
    destination: "WORKER_1",
    createdAt: expect.any(Date),
    delaySeconds: null,
    maxRetries: 5,
    executionLog: [
      {
        id: expect.any(String),
        result: "ignored",
        executedAt: expect.any(Date),
      },
    ],
  });
};

/** @internal */
export const testRepositoryPersistsMisconfiguredDispatch = async (
  repo: Repository,
) => {
  const got = await safeTry(async function* () {
    const { dispatchId } = yield* (await createEvent(repo)).safeUnwrap();

    const got = yield* (await repo.getDispatch(dispatchId)).safeUnwrap();
    assert(got !== null);
    const { dispatch } = got;
    assert(dispatch.status === "ongoing");

    const ignored = appendExecutionLog(dispatch, {
      result: "misconfigured",
      executedAt: new Date(),
    });
    yield* (await repo.saveDispatch(ignored)).safeUnwrap();

    return await repo.getDispatch(dispatchId);
  });
  assert(got.isOk());
  assert(got.value !== null);
  const { event, dispatch } = got.value;

  expect(event).toMatchObject({
    id: expect.any(String),
    payload: eventPayload,
    createdAt: expect.any(Date),
  });

  // Dispatch is ignored in first try.
  expect(dispatch).toMatchObject({
    id: expect.any(String),
    eventId: event.id,
    status: "misconfigured",
    destination: "WORKER_1",
    createdAt: expect.any(Date),
    delaySeconds: null,
    maxRetries: 5,
    executionLog: [
      {
        id: expect.any(String),
        result: "misconfigured",
        executedAt: expect.any(Date),
      },
    ],
  });
};

/** @internal */
export const testRepositoryPersistsLostDispatch = async (repo: Repository) => {
  const got = await safeTry(async function* () {
    const { dispatchId } = yield* (await createEvent(repo)).safeUnwrap();

    // Fail once.
    yield* (await dispatchFailed(repo, dispatchId)).safeUnwrap();

    // Mark dispatch as lost.
    const got = yield* (await repo.getDispatch(dispatchId)).safeUnwrap();
    assert(got !== null);
    const { dispatch } = got;
    assert(dispatch.status === "ongoing");

    const lost = makeDispatchLost(dispatch, new Date());
    yield* (await repo.saveDispatch(lost)).safeUnwrap();

    return await repo.getDispatch(dispatchId);
  });
  assert(got.isOk());
  assert(got.value !== null);
  const { event, dispatch } = got.value;

  expect(event).toMatchObject({
    id: expect.any(String),
    payload: eventPayload,
    createdAt: expect.any(Date),
  });

  // Dispatch is executed once and failed. After that, it has been lost.
  expect(dispatch).toMatchObject({
    id: expect.any(String),
    eventId: event.id,
    status: "lost",
    destination: "WORKER_1",
    createdAt: expect.any(Date),
    delaySeconds: null,
    maxRetries: 5,
    executionLog: [
      {
        id: expect.any(String),
        result: "failed",
        executedAt: expect.any(Date),
      },
    ],
  });
};

const nextDate = async () => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return new Date();
};

/** @internal */
export const testRepositoryListOngoingDispatches = async (repo: Repository) => {
  // Create dispatches.
  const result = await repo.createEvents([
    {
      payload: {},
      createdAt: new Date(),
    },
  ]);
  assert(result.isOk());
  const { id: eventId } = result.value[0];

  const dispatchIds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const createResult = await repo.createDispatches([
      {
        eventId,
        destination: `dest_${i}`,
        createdAt: await nextDate(),
        delaySeconds: null,
        maxRetries: 1,
      },
    ]);
    assert(createResult.isOk());
    const created = createResult.value[0];

    const next = appendExecutionLog(created, {
      result: i % 2 === 0 ? "failed" : "complete",
      executedAt: await nextDate(),
    });
    const saveResult = await repo.saveDispatch(next);
    assert(saveResult.isOk());

    dispatchIds.push(next.id);
  }

  // List first 3 dispatches.
  const firstResult = await repo.listOngoingDispatches(3);
  assert(firstResult.isOk());
  expect(firstResult.value).toMatchObject({
    list: [
      {
        id: dispatchIds[0],
        status: "ongoing",
        destination: "dest_0",
        delaySeconds: null,
        maxRetries: 1,
        createdAt: expect.any(Date),
        executionLog: [
          {
            result: "failed",
            executedAt: expect.any(Date),
          },
        ],
      },
      {
        id: dispatchIds[2],
        status: "ongoing",
        destination: "dest_2",
        delaySeconds: null,
        maxRetries: 1,
        createdAt: expect.any(Date),
        executionLog: [
          {
            result: "failed",
            executedAt: expect.any(Date),
          },
        ],
      },
      {
        id: dispatchIds[4],
        status: "ongoing",
        destination: "dest_4",
        delaySeconds: null,
        maxRetries: 1,
        createdAt: expect.any(Date),
        executionLog: [
          {
            result: "failed",
            executedAt: expect.any(Date),
          },
        ],
      },
    ],
    continuationToken: expect.any(String),
  });

  const secondResult = await repo.listOngoingDispatches(
    3,
    firstResult.value.continuationToken,
  );
  assert(secondResult.isOk());
  expect(secondResult.value).toMatchObject({
    list: [
      {
        id: dispatchIds[6],
        status: "ongoing",
        destination: "dest_6",
        delaySeconds: null,
        maxRetries: 1,
        createdAt: expect.any(Date),
        executionLog: [
          {
            result: "failed",
            executedAt: expect.any(Date),
          },
        ],
      },
      {
        id: dispatchIds[8],
        status: "ongoing",
        destination: "dest_8",
        delaySeconds: null,
        maxRetries: 1,
        createdAt: expect.any(Date),
        executionLog: [
          {
            result: "failed",
            executedAt: expect.any(Date),
          },
        ],
      },
      {
        id: dispatchIds[10],
        status: "ongoing",
        destination: "dest_10",
        delaySeconds: null,
        maxRetries: 1,
        createdAt: expect.any(Date),
        executionLog: [
          {
            result: "failed",
            executedAt: expect.any(Date),
          },
        ],
      },
    ],
    continuationToken: expect.any(String),
  });

  const thirdResult = await repo.listOngoingDispatches(
    3,
    secondResult.value.continuationToken,
  );
  assert(thirdResult.isOk());
  expect(thirdResult.value).toMatchObject({
    list: [
      {
        id: dispatchIds[12],
        status: "ongoing",
        destination: "dest_12",
        delaySeconds: null,
        maxRetries: 1,
        createdAt: expect.any(Date),
        executionLog: [
          {
            result: "failed",
            executedAt: expect.any(Date),
          },
        ],
      },
      {
        id: dispatchIds[14],
        status: "ongoing",
        destination: "dest_14",
        delaySeconds: null,
        maxRetries: 1,
        createdAt: expect.any(Date),
        executionLog: [
          {
            result: "failed",
            executedAt: expect.any(Date),
          },
        ],
      },
      {
        id: dispatchIds[16],
        status: "ongoing",
        destination: "dest_16",
        delaySeconds: null,
        maxRetries: 1,
        createdAt: expect.any(Date),
        executionLog: [
          {
            result: "failed",
            executedAt: expect.any(Date),
          },
        ],
      },
    ],
    continuationToken: expect.any(String),
  });

  const fourthResult = await repo.listOngoingDispatches(
    3,
    thirdResult.value.continuationToken,
  );
  assert(fourthResult.isOk());
  expect(fourthResult.value).toMatchObject({
    list: [
      {
        id: dispatchIds[18],
        status: "ongoing",
        destination: "dest_18",
        delaySeconds: null,
        maxRetries: 1,
        executionLog: [
          {
            result: "failed",
            executedAt: expect.any(Date),
          },
        ],
      },
    ],
    continuationToken: undefined,
  });
};

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

      expect(result.value).toMatchObject([
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
          maxRetries: 5,
        },
        {
          eventId: createdEvent.id,
          destination: "WORKER_2",
          createdAt,
          delaySeconds: 5,
          maxRetries: 10,
        },
      ]);
      assert(result.isOk(), "createDispatches must be succeeded");
      result.value.sort((d1, d2) => (d1.destination < d2.destination ? -1 : 1));

      expect(result.value).toMatchObject([
        {
          eventId: createdEvent.id,
          status: "ongoing",
          destination: "WORKER_1",
          createdAt: expect.any(Date),
          delaySeconds: null,
          maxRetries: 5,
        },
        {
          eventId: createdEvent.id,
          status: "ongoing",
          destination: "WORKER_2",
          createdAt: expect.any(Date),
          delaySeconds: 5,
          maxRetries: 10,
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
