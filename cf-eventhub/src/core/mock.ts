import type { EventPayload } from "./type";

export class QueueMock implements Queue<EventPayload> {
  readonly sentBatches: MessageSendRequest<EventPayload>[][] = [];
  private readonly failingBatchIndexes: Set<number>;

  constructor(failingBatchIndexes: number[] = []) {
    this.failingBatchIndexes = new Set(failingBatchIndexes);
  }

  async metrics(): Promise<QueueMetrics> {
    return {
      backlogBytes: 0,
      backlogCount: 0,
    };
  }

  async send(_message: EventPayload): Promise<QueueSendResponse> {
    throw new Error("not implemented");
  }

  async sendBatch(
    messages: Iterable<MessageSendRequest<EventPayload>>,
  ): Promise<QueueSendBatchResponse> {
    const batch = Array.from(messages);
    const batchIndex = this.sentBatches.length;
    this.sentBatches.push(batch);
    if (this.failingBatchIndexes.has(batchIndex)) {
      throw new Error(`failed batch ${batchIndex}`);
    }
    return {
      metadata: {
        metrics: {
          backlogBytes: 0,
          backlogCount: 0,
        },
      },
    };
  }
}

export class R2BucketMock {
  readonly objects = new Map<string, { body: string; contentType?: string }>();
  readonly putCalls: Array<{
    key: string;
    body: string;
    contentType?: string;
  }> = [];
  private readonly failingKeys: Set<string>;
  private readonly failAll: boolean;
  private readonly pendingPutFailures: Array<"before" | "after"> = [];

  constructor(failingKeys: string[] = [], failAll = false) {
    this.failingKeys = new Set(failingKeys);
    this.failAll = failAll;
  }

  failNextPut(timing: "before" | "after" = "before"): void {
    this.pendingPutFailures.push(timing);
  }

  async head(): Promise<R2Object | null> {
    return null;
  }

  async get(): Promise<R2ObjectBody | null> {
    return null;
  }

  async put(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    if (typeof value !== "string") {
      throw new Error("expected string payload");
    }
    const object = {
      body: value,
      // @ts-expect-error: assume httpMetadata is always R2HTTPMetadata
      contentType: options?.httpMetadata?.contentType,
    };
    this.putCalls.push({ key, ...object });
    const failure = this.pendingPutFailures.shift();
    if (this.failAll || this.failingKeys.has(key) || failure === "before") {
      throw new Error(`failed put ${key}`);
    }
    this.objects.set(key, object);
    if (failure === "after") {
      throw new Error(`failed put after write ${key}`);
    }
    return {
      key,
      version: "v1",
      size: value.length,
      etag: "etag",
      httpEtag: "etag",
      checksums: { toJSON: () => ({}) },
      uploaded: new Date(),
      storageClass: "Standard",
      writeHttpMetadata: () => {},
    } as R2Object;
  }

  async createMultipartUpload(): Promise<R2MultipartUpload> {
    throw new Error("not implemented");
  }

  resumeMultipartUpload(): R2MultipartUpload {
    throw new Error("not implemented");
  }

  async delete(): Promise<void> {}

  async list(): Promise<R2Objects> {
    return {
      objects: [],
      delimitedPrefixes: [],
      truncated: false,
    };
  }
}

export class WorkflowMock {
  readonly createBatchCalls: Array<{
    instances: WorkflowInstanceCreateOptions<EventPayload>[];
  }> = [];
  readonly instances: Map<string, EventPayload>;
  private readonly failingBatchIndexes: Set<number>;
  private readonly pendingFailures: Array<"before" | "after"> = [];
  private readonly instanceErrors = new Map<
    string,
    { code: number; message: string }
  >();

  constructor(
    failingBatchIndexes: number[] = [],
    existingInstances: Iterable<[string, EventPayload]> = [],
  ) {
    this.failingBatchIndexes = new Set(failingBatchIndexes);
    this.instances = new Map(existingInstances);
  }

  failNextBatch(timing: "before" | "after" = "before"): void {
    this.pendingFailures.push(timing);
  }

  failInstance(
    id: string,
    code = 10000,
    message = "instance creation failed",
  ): void {
    this.instanceErrors.set(id, { code, message });
  }

  recoverInstance(id: string): void {
    this.instanceErrors.delete(id);
  }

  async createBatch(options: {
    instances: WorkflowInstanceCreateOptions<EventPayload>[];
  }): Promise<WorkflowBatchCreateResult> {
    const batchIndex = this.createBatchCalls.length;
    this.createBatchCalls.push(options);
    const failure = this.pendingFailures.shift();
    if (failure === "before") {
      throw new Error(`failed Workflow batch ${batchIndex}`);
    }
    const created: WorkflowInstance[] = [];
    const errors: WorkflowBatchCreateResult["errors"] = [];
    const seenIds = new Set<string>();
    for (const [index, { id, params }] of options.instances.entries()) {
      if (id === undefined || params === undefined) {
        throw new Error("expected explicit Workflow ID and parameters");
      }
      const error = seenIds.has(id)
        ? { code: 10415, message: "duplicate ID in batch" }
        : this.instances.has(id)
          ? { code: 10405, message: "instance already exists" }
          : this.instanceErrors.get(id);
      seenIds.add(id);
      if (error) {
        errors.push({ index, id, ...error });
        continue;
      }
      this.instances.set(id, params);
      created.push({ id } as WorkflowInstance);
    }
    if (this.failingBatchIndexes.has(batchIndex) || failure === "after") {
      throw new Error(`failed Workflow batch ${batchIndex}`);
    }
    return { created, errors };
  }
}
