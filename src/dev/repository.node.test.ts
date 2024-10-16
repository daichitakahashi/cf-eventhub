import { beforeAll, describe, test } from "vitest";

import {
  testRepositoryListOngoingDispatches,
  testRepositoryPersistsCompleteDispatch,
  testRepositoryPersistsFailedDispatch,
  testRepositoryPersistsIgnoredDispatch,
  testRepositoryPersistsLostDispatch,
  testRepositoryPersistsMisconfiguredDispatch,
  testRepositoryRollback,
} from "../repositorytest";
import { DevRepository } from "./repository";

describe("repositorytest", () => {
  let repo: DevRepository;
  beforeAll(() => {
    repo = new DevRepository();
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
});

describe("repositorytest.testRepositoryListOngoingDispatches", () => {
  test("List ongoing dispatches", async () => {
    await testRepositoryListOngoingDispatches(new DevRepository());
  });
});
