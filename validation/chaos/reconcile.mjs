export const destinations = ["QUEUE", "BUCKET", "WORKFLOW"];
export const faultModes = ["fail-before", "commit-then-fail"];

export function coverageCounts(faults) {
  return Object.fromEntries(
    destinations.flatMap((destination) =>
      faultModes.map((mode) => [
        `${destination}/${mode}`,
        faults.coverage
          .filter(
            (r) =>
              r.destination === destination &&
              r.mode === mode &&
              r.outcome === "injected",
          )
          .reduce((sum, r) => sum + r.count, 0),
      ]),
    ),
  );
}
export function covered(faults, minimum) {
  return Object.values(coverageCounts(faults)).every(
    (count) => count >= minimum,
  );
}
export function reconcile({
  runId,
  published,
  expected,
  state,
  objects,
  workflows,
}) {
  const errors = [];
  const expectedById = new Map(expected.map((j) => [j.id, j]));
  const finalById = new Map(state.hub.jobs.map((j) => [j.id, j]));
  if (
    expectedById.size !== published * 3 ||
    expected.length !== expectedById.size
  )
    errors.push("Expected job cardinality does not equal published * 3");
  if (state.hub.payloads.length !== published)
    errors.push("Persisted payload count differs from published count");
  const eventIndices = new Set();
  for (const p of state.hub.payloads) {
    const body = JSON.parse(p.body);
    eventIndices.add(body.eventIndex);
    if (
      body.testRunId !== runId ||
      !Number.isInteger(body.eventIndex) ||
      body.eventIndex < 0 ||
      body.eventIndex >= published
    )
      errors.push(`Invalid persisted payload ${p.id}`);
    const jobs = expected.filter((j) => j.payloadId === p.id);
    if (
      jobs.length !== 3 ||
      destinations.some(
        (d) => jobs.filter((j) => j.destination === d).length !== 1,
      )
    )
      errors.push(`Invalid fan-out ${p.id}`);
  }
  if (eventIndices.size !== published)
    errors.push("Published event indices are missing or duplicated");
  const observations = new Map();
  let queueDuplicates = 0;
  let workflowReceiptRepeats = 0;
  for (const receipt of state.receipts) {
    const job = expectedById.get(receipt.deliveryJobId);
    if (
      !job ||
      job.destination !== receipt.destination ||
      receipt.runId !== runId ||
      !["QUEUE", "WORKFLOW"].includes(receipt.destination)
    )
      errors.push(
        `Phantom receipt ${receipt.deliveryJobId}/${receipt.destination}`,
      );
    if (
      receipt.destination === "WORKFLOW" &&
      receipt.instanceId !== receipt.deliveryJobId
    )
      errors.push(`Workflow identity mismatch ${receipt.deliveryJobId}`);
    if (!Number.isInteger(receipt.count) || receipt.count < 1)
      errors.push(`Invalid receipt count ${receipt.deliveryJobId}`);
    observations.set(
      receipt.deliveryJobId,
      (observations.get(receipt.deliveryJobId) ?? 0) + receipt.count,
    );
    if (receipt.destination === "QUEUE") queueDuplicates += receipt.count - 1;
    else workflowReceiptRepeats += receipt.count - 1;
  }
  const objectIds = new Set();
  for (const object of objects) {
    const id = object.payload?.__eventhub__?.deliveryJobId;
    const job = expectedById.get(id);
    if (
      job?.destination !== "BUCKET" ||
      object.key !== `chaos/${runId}/${id}.json` ||
      object.payload.testRunId !== runId
    ) {
      errors.push(`Phantom/invalid R2 object ${object.key}`);
      continue;
    }
    objectIds.add(id);
    observations.set(id, 1);
  }
  const workflowById = new Map(workflows.map((w) => [w.id, w]));
  const workflowJobs = expected.filter((j) => j.destination === "WORKFLOW");
  for (const job of workflowJobs) {
    if (workflowById.get(job.id)?.status !== "complete")
      errors.push(`Workflow incomplete or missing ${job.id}`);
    const identities = new Set(
      state.receipts
        .filter(
          (r) => r.destination === "WORKFLOW" && r.deliveryJobId === job.id,
        )
        .map((r) => r.instanceId),
    );
    if (identities.size !== 1 || !identities.has(job.id))
      errors.push(`Workflow logical instance count differs from one ${job.id}`);
  }
  for (const job of expected) {
    const final = finalById.get(job.id);
    if (
      !final ||
      final.destination !== job.destination ||
      final.payloadId !== job.payloadId ||
      final.finalStatus !== "completed" ||
      final.leaseToken !== null
    )
      errors.push(`Job did not converge ${job.id}`);
    if (!(observations.get(job.id) >= 1))
      errors.push(`Missing destination side effect ${job.id}`);
  }
  if (
    state.hub.jobs.length !== expected.length ||
    state.hub.jobs.some((j) => !expectedById.has(j.id))
  )
    errors.push("Final job set differs from expected set");
  return {
    pass: errors.length === 0,
    errors,
    totals: {
      published,
      expectedJobs: expected.length,
      completedJobs: state.hub.jobs.filter((j) => j.finalStatus === "completed")
        .length,
      queueJobs: expected.filter((j) => j.destination === "QUEUE").length,
      queueReceipts: state.receipts
        .filter((r) => r.destination === "QUEUE")
        .reduce((sum, r) => sum + r.count, 0),
      queueDuplicates,
      r2Objects: objectIds.size,
      workflowJobs: workflowJobs.length,
      workflowInstances: workflows.filter((w) => w.status === "complete")
        .length,
      workflowReceiptRepeats,
    },
  };
}
