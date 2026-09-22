import type { ListResult } from "cf-eventhub";
import { describe, expect, test } from "vitest";

import {
  formatDeliveryAttempts,
  getEventsLastUpdatedAt,
  normalizeEvents,
} from "./eventhub";

describe("formatDeliveryAttempts", () => {
  test.each([
    {
      scenario: "an ongoing job with one failure",
      job: { failedAttemptCount: 1, finalStatus: null },
      expected: "1 failure",
    },
    {
      scenario: "a job completed on its first attempt",
      job: { failedAttemptCount: 0, finalStatus: "completed" as const },
      expected: "1 attempt",
    },
    {
      scenario: "a job completed after two failures",
      job: { failedAttemptCount: 2, finalStatus: "completed" as const },
      expected: "3 attempts",
    },
    {
      scenario: "a job permanently failed after eleven attempts",
      job: { failedAttemptCount: 11, finalStatus: "failed" as const },
      expected: "11 attempts",
    },
  ])("formats $scenario", ({ job, expected }) => {
    expect(formatDeliveryAttempts(job)).toBe(expected);
  });
});

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
