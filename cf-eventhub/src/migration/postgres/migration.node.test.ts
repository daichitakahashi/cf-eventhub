import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

describe.sequential("Postgres migration", () => {
  let pglite: PGlite;
  let applyMigration: (filename: string) => Promise<void>;
  beforeAll(async () => {
    pglite = new PGlite();
    applyMigration = async (filename) => {
      const sql = await fs.readFile(path.join(__dirname, filename), "utf-8");
      await pglite.exec(sql);
    };
  });
  afterAll(async () => {
    await pglite.close();
  });

  test("Initial migration", async () => {
    await applyMigration("0000_busy_pestilence.sql");
    await applyMigration("0001_misty_black_cat.sql");

    await pglite.exec(
      `INSERT INTO eventhub.events (id, payload, created_at)
        VALUES ('783e9853-f59c-4c29-a8dd-3e9058655875', '{}', now());`,
    );
    await pglite.exec(
      `INSERT INTO eventhub.dispatches (
            id,
            event_id,
            destination,
            created_at,
            delay_seconds,
            max_retries
        ) VALUES (
            'f3ef2570-c42c-4218-8dd7-084926576509',
            '783e9853-f59c-4c29-a8dd-3e9058655875',
            'DEST1',
            now(),
            NULL, -- without delay_seconds
            3
        ), (
            'fbb14913-a606-46fa-ab55-b6ea846ad742',
            '783e9853-f59c-4c29-a8dd-3e9058655875',
            'DEST2',
            now(),
            10, -- with delay_seconds(10s)
            3
        );
    `,
    );
  });

  test("Add retry_delay and construct that values using 'delay_seconds'", async () => {
    await applyMigration("0002_omniscient_multiple_man.sql");

    const { rows: dispatches } = await pglite.query(
      "SELECT * FROM eventhub.dispatches ORDER BY destination",
    );
    expect(dispatches[0]).toMatchObject({
      id: "f3ef2570-c42c-4218-8dd7-084926576509",
      event_id: "783e9853-f59c-4c29-a8dd-3e9058655875",
      destination: "DEST1",
      delay_seconds: 0,
      max_retries: 3,
      retry_delay: {
        type: "constant",
        interval: 0,
      },
    });
    expect(dispatches[1]).toMatchObject({
      id: "fbb14913-a606-46fa-ab55-b6ea846ad742",
      event_id: "783e9853-f59c-4c29-a8dd-3e9058655875",
      destination: "DEST2",
      delay_seconds: 10,
      max_retries: 3,
      retry_delay: {
        type: "constant",
        interval: 10,
      },
    });
  });
});
