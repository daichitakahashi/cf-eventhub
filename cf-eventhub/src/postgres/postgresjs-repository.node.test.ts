import * as path from "node:path";
import postgres from "postgres";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { assert, afterAll, beforeAll, describe, test } from "vitest";

import { DefaultLogger } from "../core/logger";
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
} from "../repositorytest";
import { createRepository } from "./postgresjs-repository";

const preparePostgres = () =>
  new GenericContainer("postgres:16.1")
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

const prepareDatabase = async (dsn: URL) => {
  const template = dsn.pathname.replaceAll("/", "");
  const sql = postgres(dsn.toString());
  const database = crypto.randomUUID().toLowerCase().replaceAll("-", "");
  await sql.unsafe(`create database "${database}" TEMPLATE ${template}`);
  await sql.end();
  const newDSN = new URL(dsn);
  newDSN.pathname = database;
  return newDSN.toString();
};

const prepareRepository = async (dsn: URL) =>
  createRepository(
    {
      EVENTHUB_DSN: await prepareDatabase(dsn),
    },
    new DefaultLogger("DEBUG"),
  );

describe("repositorytest", () => {
  let container: StartedTestContainer;
  let templateDsn: URL;
  beforeAll(async () => {
    // launch postgres container
    container = await preparePostgres();

    templateDsn = new URL("", "postgresql://");
    templateDsn.hostname = container.getHost();
    templateDsn.port = container.getMappedPort(5432).toString();
    templateDsn.pathname = "test";
    templateDsn.username = "test";
    templateDsn.password = "test";
  });
  afterAll(async () => {
    await container.stop();
  });

  test("Persists complete dispatch", async () => {
    const repo = await prepareRepository(templateDsn);
    await testRepositoryPersistsCompleteDispatch(repo);
  });

  test("Persists failed dispatch", async () => {
    const repo = await prepareRepository(templateDsn);
    await testRepositoryPersistsFailedDispatch(repo);
  });

  test("Persists ignored dispatch", async () => {
    const repo = await prepareRepository(templateDsn);
    await testRepositoryPersistsIgnoredDispatch(repo);
  });

  test("Persists misconfigured dispatch", async () => {
    const repo = await prepareRepository(templateDsn);
    await testRepositoryPersistsMisconfiguredDispatch(repo);
  });

  test("Persists lost dispatch", async () => {
    const repo = await prepareRepository(templateDsn);
    await testRepositoryPersistsLostDispatch(repo);
  });

  test("Rollback by Result(Err)", async () => {
    const repo = await prepareRepository(templateDsn);
    await testRepositoryRollback(repo, "RESULT");
  });

  test("Rollback by exception", async () => {
    const repo = await prepareRepository(templateDsn);
    await testRepositoryRollback(repo, "THROW");
  });

  test("List ongoing dispatches", async () => {
    const repo = await prepareRepository(templateDsn);
    await testRepositoryListOngoingDispatches(repo);
  });

  test("List events", async () => {
    const repo = await prepareRepository(templateDsn);
    const result = await repo.createEvents([
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
    ]);
    assert(result.isOk());
    assert(result.value.length === 3);
    const events = result.value as [CreatedEvent, CreatedEvent, CreatedEvent];

    await testRepositoryListEventsAsc(repo, events);
    await testRepositoryListEventsDesc(repo, events);
  });

  test("Dispatch and execution order of events", async () => {
    const repo = await prepareRepository(templateDsn);
    await testRepositoryListEventDispatches(repo);
  });
});
