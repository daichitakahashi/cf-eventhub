import type { ListResult } from "cf-eventhub";
import { describe, expect, test } from "vitest";

import { getEventsLastUpdatedAt, normalizeEvents } from "./eventhub";

describe("normalizeEvents", () => {
  test("uses payload identity for an event without delivery jobs", () => {
    const result: ListResult = {
      payloads: [
        {
          payloadId: "payload-no-route",
          createdAt: "2026-09-15T01:02:03.000Z",
          payload: { kind: "other" },
          deliveryJobs: [],
        },
      ],
    };

    const events = normalizeEvents(result);

    expect(events).toStrictEqual([
      {
        id: "payload-no-route",
        createdAt: "2026-09-15T01:02:03.000Z",
        payload: { kind: "other" },
        deliveryJobs: [],
      },
    ]);
  });
});

describe("getEventsLastUpdatedAt", () => {
  test("detects a new event without delivery jobs", () => {
    const events = normalizeEvents({
      payloads: [
        {
          payloadId: "payload-no-route",
          createdAt: "2026-09-15T01:02:03.000Z",
          payload: { kind: "other" },
          deliveryJobs: [],
        },
      ],
    });

    expect(getEventsLastUpdatedAt(events)).toBe(
      Date.parse("2026-09-15T01:02:03.000Z"),
    );
  });
});
