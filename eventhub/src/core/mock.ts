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
	private readonly failingKeys: Set<string>;

	constructor(failingKeys: string[] = []) {
		this.failingKeys = new Set(failingKeys);
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
		if (this.failingKeys.has(key)) {
			throw new Error(`failed put ${key}`);
		}
		if (typeof value !== "string") {
			throw new Error("expected string payload");
		}
		this.objects.set(key, {
			body: value,
			// @ts-expect-error: assume httpMetadata is always R2HTTPMetadata
			contentType: options?.httpMetadata?.contentType,
		});
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
