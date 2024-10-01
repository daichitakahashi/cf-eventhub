import * as path from "node:path";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, test } from "vitest";

import {
  testRepositoryPersistsCompleteDispatch,
  testRepositoryPersistsFailedDispatch,
  testRepositoryPersistsIgnoredDispatch,
  testRepositoryPersistsLostDispatch,
  testRepositoryPersistsMisconfiguredDispatch,
  testRepositoryRollback,
} from "../repositorytest";
import { createRepository } from "./postgresjs-repository";

describe("repositorytest", () => {
  let container: StartedTestContainer;
  let dsn: string;
  beforeAll(async () => {
    // launch postgres container
    container = await new GenericContainer("postgres:16.1")
      .withEnvironment({
        POSTGRES_DB: "test",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withWaitStrategy(
        Wait.forLogMessage(
          /.*database system is ready to accept connections.*/,
          2,
        ),
      )
      .withExposedPorts(5432)
      .withStartupTimeout(120000)
      .withBindMounts([
        {
          source: path.join(__dirname, "..", "migration", "postgres"),
          target: "/docker-entrypoint-initdb.d",
        },
      ])
      .start();

    const u = new URL("", "postgresql://");
    u.hostname = container.getHost();
    u.port = container.getMappedPort(5432).toString();
    u.pathname = "test";
    u.username = "test";
    u.password = "test";
    dsn = u.toString();
  });
  afterAll(async () => {
    await container.stop();
  });

  test("Persists complete dispatch", async () => {
    const repo = createRepository({
      EVENTHUB_DSN: dsn,
    });
    await testRepositoryPersistsCompleteDispatch(repo);
  });

  test("Persists failed dispatch", async () => {
    const repo = createRepository({
      EVENTHUB_DSN: dsn,
    });
    await testRepositoryPersistsFailedDispatch(repo);
  });

  test("Persists ignored dispatch", async () => {
    const repo = createRepository({
      EVENTHUB_DSN: dsn,
    });
    await testRepositoryPersistsIgnoredDispatch(repo);
  });

  test("Persists misconfigured dispatch", async () => {
    const repo = createRepository({
      EVENTHUB_DSN: dsn,
    });
    await testRepositoryPersistsMisconfiguredDispatch(repo);
  });

  test("Persists lost dispatch", async () => {
    const repo = createRepository({
      EVENTHUB_DSN: dsn,
    });
    await testRepositoryPersistsLostDispatch(repo);
  });

  test("Rollback by Result(Err)", async () => {
    const repo = createRepository({
      EVENTHUB_DSN: dsn,
    });
    await testRepositoryRollback(repo, "RESULT");
  });

  test("Rollback by exception", async () => {
    const repo = createRepository({
      EVENTHUB_DSN: dsn,
    });
    await testRepositoryRollback(repo, "THROW");
  });
});
