import assert from "node:assert/strict";
import test from "node:test";
import { covered, reconcile } from "../reconcile.mjs";

const fixture = () => {
  const expected = ["QUEUE", "BUCKET", "WORKFLOW"].map((destination, i) => ({
    id: `job${i}`,
    payloadId: "payload",
    destination,
  }));
  return {
    runId: "test",
    published: 1,
    expected,
    state: {
      hub: {
        payloads: [
          {
            id: "payload",
            body: JSON.stringify({ testRunId: "test", eventIndex: 0 }),
          },
        ],
        jobs: expected.map((j) => ({
          ...j,
          finalStatus: "completed",
          leaseToken: null,
        })),
      },
      receipts: [
        {
          runId: "test",
          deliveryJobId: "job0",
          destination: "QUEUE",
          instanceId: "",
          count: 2,
        },
        {
          runId: "test",
          deliveryJobId: "job2",
          destination: "WORKFLOW",
          instanceId: "job2",
          count: 1,
        },
      ],
    },
    objects: [
      {
        key: "chaos/test/job1.json",
        payload: { testRunId: "test", __eventhub__: { deliveryJobId: "job1" } },
      },
    ],
    workflows: [{ id: "job2", status: "complete" }],
  };
};
test("allows at-least-once Queue duplicates while requiring all destination evidence", () => {
  const result = reconcile(fixture());
  assert.deepEqual(
    {
      pass: result.pass,
      errors: result.errors,
      duplicates: result.totals.queueDuplicates,
    },
    { pass: true, errors: [], duplicates: 1 },
  );
});
for (const destination of ["QUEUE", "BUCKET", "WORKFLOW"]) {
  test(`rejects missing independent ${destination} evidence despite completed EventHub jobs`, () => {
    const input = fixture();
    if (destination === "BUCKET") input.objects = [];
    else
      input.state.receipts = input.state.receipts.filter(
        (r) => r.destination !== destination,
      );
    assert.equal(reconcile(input).pass, false);
  });
}
test("rejects phantom receipts and R2 objects", () => {
  const input = fixture();
  input.state.receipts.push({
    ...input.state.receipts[0],
    deliveryJobId: "phantom",
  });
  input.objects.push({
    key: "chaos/test/phantom.json",
    payload: { testRunId: "test", __eventhub__: { deliveryJobId: "phantom" } },
  });
  assert.equal(
    reconcile(input).errors.filter((e) => e.startsWith("Phantom")).length,
    2,
  );
});
for (const [description, payload] of [
  ["missing", undefined],
  ["null", null],
  ["primitive", "invalid"],
  ["array", []],
  ["missing metadata", { testRunId: "test" }],
  [
    "unknown job",
    { testRunId: "test", __eventhub__: { deliveryJobId: "unknown" } },
  ],
  [
    "wrong run",
    { testRunId: "other", __eventhub__: { deliveryJobId: "job1" } },
  ],
]) {
  test(`reports ${description} R2 payload without counting it as delivery evidence`, () => {
    const input = fixture();
    input.objects[0].payload = payload;
    const result = reconcile(input);
    assert.deepEqual(
      {
        pass: result.pass,
        errors: result.errors,
        r2Objects: result.totals.r2Objects,
      },
      {
        pass: false,
        errors: [
          "Phantom/invalid R2 object chaos/test/job1.json",
          "Missing destination side effect job1",
        ],
        r2Objects: 0,
      },
    );
  });
}
test("excludes an R2 object with the wrong key from delivery evidence", () => {
  const input = fixture();
  input.objects[0].key = "chaos/test/other.json";
  const result = reconcile(input);
  assert.deepEqual(
    {
      pass: result.pass,
      errors: result.errors,
      r2Objects: result.totals.r2Objects,
    },
    {
      pass: false,
      errors: [
        "Phantom/invalid R2 object chaos/test/other.json",
        "Missing destination side effect job1",
      ],
      r2Objects: 0,
    },
  );
});
for (const finalStatus of [null, "failed"]) {
  test(`rejects non-successful job state ${finalStatus}`, () => {
    const input = fixture();
    input.state.hub.jobs[0].finalStatus = finalStatus;
    assert.equal(reconcile(input).pass, false);
  });
}
test("rejects an indefinitely leased completed job", () => {
  const input = fixture();
  input.state.hub.jobs[0].leaseToken = "lease";
  assert.equal(reconcile(input).pass, false);
});
test("rejects a different logical Workflow instance ID", () => {
  const input = fixture();
  input.state.receipts[1].instanceId = "other";
  assert.equal(reconcile(input).pass, false);
});
test("rejects missing or incomplete Workflow instances", () => {
  const input = fixture();
  input.workflows[0].status = "running";
  assert.equal(reconcile(input).pass, false);
});
test("rejects a final job set silently reduced after the expected snapshot", () => {
  const input = fixture();
  input.state.hub.jobs.pop();
  assert.equal(reconcile(input).pass, false);
});
test("coverage requires every destination and mode, and counts only applied faults", () => {
  const coverage = ["QUEUE", "BUCKET", "WORKFLOW"].flatMap((destination) =>
    ["fail-before", "commit-then-fail"].map((mode) => ({
      destination,
      mode,
      outcome: "injected",
      count: 3,
    })),
  );
  assert.equal(covered({ coverage }, 3), true);
  coverage[5].outcome = "no-new-commit";
  assert.equal(covered({ coverage }, 3), false);
});
