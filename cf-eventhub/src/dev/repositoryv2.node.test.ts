import { assert, beforeAll, describe, test } from "vitest";

import type { CreatedEvent } from "../core/model";
import {
  nextDate,
  testRepositoryListEventDispatches,
  testRepositoryListEventsAsc,
  testRepositoryListEventsDesc,
  testRepositoryListOngoingDispatches,
  testRepositoryPersistsCompleteDispatch,
  testRepositoryPersistsFailedDispatch,
  testRepositoryPersistsIgnoredDispatch,
  testRepositoryPersistsLostDispatch,
  testRepositoryPersistsMisconfiguredDispatch,
  testRepositoryRollback,
} from "../repositorytest/v2";
import { DevRepositoryV2 } from "./repository";

describe("repositorytest", () => {
  let repo: DevRepositoryV2;
  beforeAll(() => {
    repo = new DevRepositoryV2();
  });
  test("Persists complete dispatch", async () => {
    await testRepositoryPersistsCompleteDispatch(repo);
  });

  test("Persists failed dispatch", async () => {
    await testRepositoryPersistsFailedDispatch(repo);
  });

  test("Persists ignored dispatch", async () => {
    await testRepositoryPersistsIgnoredDispatch(repo);
  });

  test("Persists misconfigured dispatch", async () => {
    await testRepositoryPersistsMisconfiguredDispatch(repo);
  });

  test("Persists lost dispatch", async () => {
    await testRepositoryPersistsLostDispatch(repo);
  });

  test("Rollback by Result(Err)", async () => {
    await testRepositoryRollback(repo, "RESULT");
  });

  test("Rollback by exception", async () => {
    await testRepositoryRollback(repo, "THROW");
  });

  test("List ongoing dispatches", async () => {
    await testRepositoryListOngoingDispatches(new DevRepositoryV2());
  });

  test("List events", async () => {
    const repo = new DevRepositoryV2();
    const result = await repo.mutate(async (tx) =>
      tx.createEvents([
        {
          payload: {
            id: crypto.randomUUID(),
          },
          createdAt: await nextDate(),
        },
        {
          payload: {
            id: crypto.randomUUID(),
          },
          createdAt: await nextDate(),
        },
        {
          payload: {
            id: crypto.randomUUID(),
          },
          createdAt: await nextDate(),
        },
      ]),
    );
    assert(result.isOk());
    assert(result.value.length === 3);
    const events = result.value as [CreatedEvent, CreatedEvent, CreatedEvent];

    await testRepositoryListEventsAsc(repo, events);
    await testRepositoryListEventsDesc(repo, events);
  });

  test("Dispatch and execution order of events", async () => {
    await testRepositoryListEventDispatches(new DevRepositoryV2());
  });
});
