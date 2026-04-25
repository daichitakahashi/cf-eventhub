import * as v from "valibot";

import { formatException } from "../utils/format-exception";
import type { Logger } from "./logger";
import type { QueueMessage } from "./type";

export const FAST_PATH_PATH = "/__cf_eventhub/fast-path";

const SIGNATURE_HEADER = "x-cf-eventhub-signature";
const TIMESTAMP_HEADER = "x-cf-eventhub-timestamp";
const SIGNATURE_VERSION = "v1";
const DEFAULT_TOLERANCE_SECONDS = 300;

const FastPathPayload = v.object({
  dispatches: v.array(
    v.object({
      dispatchId: v.pipe(v.string(), v.minLength(1)),
      retryDelay: v.variant("type", [
        v.object({
          type: v.literal("constant"),
          interval: v.number(),
        }),
        v.object({
          type: v.literal("exponential"),
          base: v.number(),
          max: v.number(),
        }),
      ]),
    }),
  ),
});

export type FastPathPayload = v.InferOutput<typeof FastPathPayload>;

const encoder = new TextEncoder();

const bytesToHex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const timingSafeEqual = (a: string, b: string) => {
  const aBytes = encoder.encode(a.toLowerCase());
  const bBytes = encoder.encode(b.toLowerCase());
  const lengthsMatch = aBytes.byteLength === bBytes.byteLength;
  return lengthsMatch
    ? crypto.subtle.timingSafeEqual(aBytes, bBytes)
    : !crypto.subtle.timingSafeEqual(aBytes, aBytes);
};

const importKey = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

const sign = async (secret: string, timestamp: string, body: string) => {
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${body}`),
  );
  return bytesToHex(signature);
};

export class FastPathClient {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly logger: Logger,
  ) {}

  async dispatch(messages: QueueMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const body = JSON.stringify({ dispatches: messages });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await sign(this.secret, timestamp, body);
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: `${SIGNATURE_VERSION}=${signature}`,
      },
      body,
    });
    if (!response.ok) {
      this.logger.error("fast path request failed", {
        status: response.status,
        statusText: response.statusText,
      });
    }
  }
}

export const parseFastPathRequest = async (
  request: Request,
  secret: string,
  now = new Date(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): Promise<FastPathPayload | null> => {
  if (request.method !== "POST") {
    return null;
  }

  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!timestamp || !signature?.startsWith(`${SIGNATURE_VERSION}=`)) {
    return null;
  }

  const timestampSeconds = Number.parseInt(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(now.getTime() / 1000 - timestampSeconds) > toleranceSeconds
  ) {
    return null;
  }

  const body = await request.text();
  const expected = await sign(secret, timestamp, body);
  const actual = signature.slice(`${SIGNATURE_VERSION}=`.length);
  if (!timingSafeEqual(expected, actual)) {
    return null;
  }

  try {
    return v.parse(FastPathPayload, JSON.parse(body));
  } catch (e) {
    console.error("invalid fast path payload", formatException(e));
    return null;
  }
};
