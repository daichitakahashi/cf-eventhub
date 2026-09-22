import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { initializeRegistrySchema, registerInstance } from "../registry-store";
import { initializeSchema } from "../store";
import { migrateSchema } from "./schema-migration";

const schemaVersion = (sql: SqlStorage): number =>
  sql.exec<{ version: number }>("SELECT version FROM schema_metadata").one()
    .version;

describe("SQLite schema migrations", () => {
  test("initializes both Durable Object schemas at version 1", async () => {
    const hub = env.EVENT_HUB.getByName("schema-fresh-hub");
    const registry = env.EVENT_HUB_REGISTRY.getByName("schema-fresh-registry");
    const hubVersion = await runInDurableObject(hub, (_instance, state) =>
      schemaVersion(state.storage.sql),
    );
    const registryVersion = await runInDurableObject(
      registry,
      (_instance, state) => schemaVersion(state.storage.sql),
    );
    expect({ hubVersion, registryVersion }).toStrictEqual({
      hubVersion: 1,
      registryVersion: 1,
    });
  });

  test("adopts an existing unversioned schema without losing data", async () => {
    // 1. Persist rows in both initialized Durable Objects.
    // 2. Remove their version markers to simulate databases from before versioning.
    // 3. Reinitialize and verify that the existing rows survive.
    const hub = env.EVENT_HUB.getByName("schema-legacy-hub");
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO payloads (id, body, created_at) VALUES ('existing', '{}', '2026-01-01')",
      );
      state.storage.sql.exec("DROP TABLE schema_metadata");
      initializeSchema(state.storage);
      expect({
        version: schemaVersion(state.storage.sql),
        rows: state.storage.sql
          .exec<{ id: string }>("SELECT id FROM payloads")
          .toArray(),
      }).toStrictEqual({ version: 1, rows: [{ id: "existing" }] });
    });

    const registry = env.EVENT_HUB_REGISTRY.getByName("schema-legacy-registry");
    await runInDurableObject(registry, (_instance, state) => {
      registerInstance(state.storage.sql, "existing", 1000, 0);
      state.storage.sql.exec("DROP TABLE schema_metadata");
      initializeRegistrySchema(state.storage);
      const rows = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM eventhub_instances")
        .toArray();
      expect({ version: schemaVersion(state.storage.sql), rows }).toStrictEqual(
        {
          version: 1,
          rows: [{ name: "existing" }],
        },
      );
    });
  });

  test("applies sequential upgrades and rolls back a failed step", async () => {
    // 1. Reset the marker and apply a synthetic v1 migration.
    // 2. Fail v2 after a schema change and verify the whole step rolls back.
    // 3. Retry v2 successfully without replaying v1.
    const hub = env.EVENT_HUB.getByName("schema-upgrade-hub");
    await runInDurableObject(hub, (_instance, state) => {
      const { sql } = state.storage;
      sql.exec("DELETE FROM schema_metadata");
      const createV1 = (db: SqlStorage) => {
        db.exec("CREATE TABLE synthetic_upgrade (id INTEGER PRIMARY KEY)");
      };
      const createV2 = (db: SqlStorage) => {
        db.exec("ALTER TABLE synthetic_upgrade ADD COLUMN value TEXT");
      };
      const failV2 = (db: SqlStorage) => {
        createV2(db);
        throw new Error("synthetic failure");
      };

      expect(() => migrateSchema(state.storage, [createV1, failV2])).toThrow(
        "synthetic failure",
      );
      expect({
        version: schemaVersion(sql),
        columns: sql
          .exec<{ name: string }>("PRAGMA table_info(synthetic_upgrade)")
          .toArray()
          .map((row) => row.name),
      }).toStrictEqual({ version: 1, columns: ["id"] });

      migrateSchema(state.storage, [createV1, createV2]);
      expect({
        version: schemaVersion(sql),
        columns: sql
          .exec<{ name: string }>("PRAGMA table_info(synthetic_upgrade)")
          .toArray()
          .map((row) => row.name),
      }).toStrictEqual({ version: 2, columns: ["id", "value"] });
    });
  });
});
