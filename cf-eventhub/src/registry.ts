import { DurableObject } from "cloudflare:workers";

import {
  getInstance,
  initializeRegistrySchema,
  listInstances,
  type RegistryInstance,
  type RegistryInstanceStatus,
  registerInstance,
  tombstoneInstance,
} from "./core/registry-store";
import { type Result, resultError, resultOk, rpcBoundary } from "./errors";

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

const validateName = (name: string): Result<string> => {
  if (typeof name !== "string" || name.length === 0) {
    return resultError(
      "INVALID_ARGUMENT",
      "eventhub registry: name must not be empty",
    );
  }
  return resultOk(name);
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

const decodeCursor = (cursor: string): Result<string> => {
  let name: string;
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    name = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    return resultError("INVALID_CURSOR", "eventhub registry: invalid cursor");
  }
  return name.length > 0 && encodeCursor(name) === cursor
    ? resultOk(name)
    : resultError("INVALID_CURSOR", "eventhub registry: invalid cursor");
};

export class EventHubRegistry extends DurableObject<Record<string, never>> {
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    initializeRegistrySchema(this.ctx.storage);
  }

  register(name: string): Promise<Result<EventHubInstance>> {
    return rpcBoundary("registry.register", async () => {
      const validated = validateName(name);
      if (!validated.ok) return validated;
      return resultOk(await this.#register(validated.value));
    });
  }

  get(name: string): Promise<Result<EventHubInstance | null>> {
    return rpcBoundary("registry.get", async () => {
      const validated = validateName(name);
      if (!validated.ok) return validated;
      return resultOk(await this.#get(validated.value));
    });
  }

  list(
    options: ListEventHubInstancesOptions = {},
  ): Promise<Result<ListEventHubInstancesResult>> {
    return rpcBoundary("registry.list", async () => {
      const status = options.status ?? "active";
      if (status !== "active" && status !== "stale" && status !== "deleted") {
        return resultError(
          "INVALID_ARGUMENT",
          "eventhub registry: invalid status",
        );
      }
      const max = options.max ?? DEFAULT_LIST_MAX;
      if (!Number.isInteger(max) || max < 1 || max > MAX_LIST_MAX) {
        return resultError(
          "INVALID_ARGUMENT",
          "eventhub registry: max must be an integer in 1..100",
        );
      }
      let cursorName: string | undefined;
      if (options.cursor !== undefined) {
        const cursor = decodeCursor(options.cursor);
        if (!cursor.ok) return cursor;
        cursorName = cursor.value;
      }
      return resultOk(await this.#list(status, cursorName, max));
    });
  }

  delete(name: string): Promise<Result<boolean>> {
    return rpcBoundary("registry.delete", async () => {
      const validated = validateName(name);
      if (!validated.ok) return validated;
      return resultOk(await this.#delete(validated.value));
    });
  }

  async #register(name: string): Promise<EventHubInstance> {
    const now = Date.now();
    return registerInstance(
      this.ctx.storage.sql,
      name,
      now,
      now - EVENT_HUB_STALE_AFTER_MS,
    );
  }

  async #get(name: string): Promise<EventHubInstance | null> {
    return getInstance(
      this.ctx.storage.sql,
      name,
      Date.now() - EVENT_HUB_STALE_AFTER_MS,
    );
  }

  async #list(
    status: EventHubInstanceStatus,
    cursorName: string | undefined,
    max: number,
  ): Promise<ListEventHubInstancesResult> {
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

  async #delete(name: string): Promise<boolean> {
    return tombstoneInstance(this.ctx.storage.sql, name, Date.now());
  }
}
