import { DurableObject } from "cloudflare:workers";

import {
  type RegistryInstance,
  type RegistryInstanceStatus,
  initializeRegistrySchema,
  listInstances,
  registerInstance,
  tombstoneInstance,
} from "./core/registry-store";

export type EventHubInstanceStatus = RegistryInstanceStatus;
export type EventHubInstance = RegistryInstance;

export type ListEventHubInstancesOptions = {
  status?: EventHubInstanceStatus;
  cursor?: string;
  max?: number;
};

export type ListEventHubInstancesResult = {
  instances: EventHubInstance[];
  cursor?: string;
};

export const EVENT_HUB_REGISTRY_NAME = "default";
export const EVENT_HUB_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_LIST_MAX = 50;
const MAX_LIST_MAX = 100;

const assertName = (name: string): void => {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("eventhub registry: name must not be empty");
  }
};

const encodeCursor = (name: string): string => {
  const bytes = new TextEncoder().encode(name);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const decodeCursor = (cursor: string): string => {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const name = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    if (name.length === 0 || encodeCursor(name) !== cursor) throw new Error();
    return name;
  } catch {
    throw new Error("eventhub registry: invalid cursor");
  }
};

export class EventHubRegistry extends DurableObject<Record<string, never>> {
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    initializeRegistrySchema(this.ctx.storage.sql);
  }

  async register(name: string): Promise<EventHubInstance> {
    assertName(name);
    const now = Date.now();
    return registerInstance(
      this.ctx.storage.sql,
      name,
      now,
      now - EVENT_HUB_STALE_AFTER_MS,
    );
  }

  async list(
    options: ListEventHubInstancesOptions = {},
  ): Promise<ListEventHubInstancesResult> {
    const status = options.status ?? "active";
    if (status !== "active" && status !== "stale" && status !== "deleted") {
      throw new Error("eventhub registry: invalid status");
    }
    const max = options.max ?? DEFAULT_LIST_MAX;
    if (!Number.isInteger(max) || max < 1 || max > MAX_LIST_MAX) {
      throw new Error("eventhub registry: max must be an integer in 1..100");
    }
    const cursorName =
      options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    const now = Date.now();
    const result = listInstances(
      this.ctx.storage.sql,
      status,
      cursorName,
      max,
      now - EVENT_HUB_STALE_AFTER_MS,
    );
    return {
      instances: result.instances,
      ...(result.nextName ? { cursor: encodeCursor(result.nextName) } : {}),
    };
  }

  async delete(name: string): Promise<boolean> {
    assertName(name);
    return tombstoneInstance(this.ctx.storage.sql, name, Date.now());
  }
}
