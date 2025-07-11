import { type Result, err, ok } from "neverthrow";

import {
  type CreatedEvent,
  type Dispatch,
  type Event,
  type NewDispatch,
  type NewEvent,
  type OngoingDispatch,
  createdEvent,
  dispatchExecution,
  isNewDispatchExecution,
  ongoingDispatch,
} from "../core/model";
import type {
  EventWithDispatches,
  MutationRepository,
  Repository,
} from "../core/repository";
import { Locker } from "./locker";

const encodeContinuationToken = (id: string) => btoa(id);

const decodeContinuationToken = (token: string) => atob(token);

export class DevRepository implements Repository {
  private readonly dispatchesLocker = new Locker();
  private readonly events = new Map<string, CreatedEvent>();
  private readonly dispatches = new Map<string, Dispatch>();

  async mutate<T, E>(
    fn: (tx: MutationRepository) => Promise<Result<T, E>>,
  ): Promise<Result<T, "INTERNAL_SERVER_ERROR" | E>> {
    const tx = new DevMutationRepository(
      this.dispatchesLocker,
      this.events,
      this.dispatches,
    );
    try {
      const result = await fn(tx);
      if (result.isOk()) {
        tx.commit();
      }
      return result;
    } catch {
      return err("INTERNAL_SERVER_ERROR" as const);
    } finally {
      tx.release();
    }
  }

  async readEvent(
    eventId: string,
  ): Promise<Result<EventWithDispatches | null, "INTERNAL_SERVER_ERROR">> {
    const event = this.events.get(eventId);
    if (!event) {
      return ok(null);
    }
    const dispatches = [...this.dispatches.values()].filter(
      (d) => d.eventId === eventId,
    );
    return ok({
      ...event,
      dispatches,
    });
  }

  async readDispatches(
    maxItems: number,
    continuationToken?: string,
    filterByStatus?: Dispatch["status"][],
    orderBy?: "CREATED_AT_ASC" | "CREATED_AT_DESC",
  ): Promise<
    Result<
      { list: Dispatch[]; continuationToken?: string },
      "INTERNAL_SERVER_ERROR" | "INVALID_CONTINUATION_TOKEN"
    >
  > {
    const order = orderBy || "CREATED_AT_ASC";
    const values = [...this.dispatches.values()];
    if (order === "CREATED_AT_DESC") {
      values.reverse();
    }

    let lastIndex = 0;
    if (continuationToken) {
      const lastId = decodeContinuationToken(continuationToken);
      const last = values.findIndex((v) => v.id === lastId);
      if (last < 0) {
        return err("INVALID_CONTINUATION_TOKEN");
      }
      lastIndex = last;
    }

    const list = lastIndex ? values.slice(lastIndex + 1) : values;
    const filter = filterByStatus ? new Set(filterByStatus) : undefined;
    const result: Dispatch[] = [];
    for (const dispatch of list) {
      if (filter && !filter.has(dispatch.status)) {
        continue;
      }
      result.push(dispatch);
      if (result.length > maxItems) {
        break;
      }
    }

    if (result.length > maxItems) {
      return ok({
        list: result.slice(0, -1),
        continuationToken: encodeContinuationToken(
          result[result.length - 2].id,
        ),
      });
    }
    return ok({
      list: result,
      continuationToken: undefined,
    });
  }

  async readEvents(
    maxItems: number,
    continuationToken?: string,
    orderBy?: "CREATED_AT_ASC" | "CREATED_AT_DESC",
  ): Promise<
    Result<
      { list: EventWithDispatches[]; continuationToken?: string },
      "INTERNAL_SERVER_ERROR" | "INVALID_CONTINUATION_TOKEN"
    >
  > {
    const order = orderBy || "CREATED_AT_ASC";
    const values = [...this.events.values()];
    if (order === "CREATED_AT_DESC") {
      values.reverse();
    }

    let lastIndex = 0;
    if (continuationToken) {
      const lastId = decodeContinuationToken(continuationToken);
      const last = values.findIndex((v) => v.id === lastId);
      if (last < 0) {
        return err("INVALID_CONTINUATION_TOKEN");
      }
      lastIndex = last;
    }

    const list = lastIndex ? values.slice(lastIndex + 1) : values;
    const dispatches = [...this.dispatches.values()];
    const result: EventWithDispatches[] = [];
    for (const event of list) {
      const eventDispatches = dispatches.filter((d) => d.eventId === event.id);
      result.push({
        ...event,
        dispatches: eventDispatches,
      });
      if (result.length > maxItems) {
        break;
      }
    }

    if (result.length > maxItems) {
      return ok({
        list: result.slice(0, -1),
        continuationToken: encodeContinuationToken(
          result[result.length - 2].id,
        ),
      });
    }
    return ok({
      list: result,
      continuationToken: undefined,
    });
  }
}

class DevMutationRepository implements MutationRepository {
  private readonly eventSink = new Map<string, CreatedEvent>();
  private readonly dispatchSink = new Map<string, Dispatch>();
  private readonly releases: (() => void)[] = [];
  constructor(
    private readonly dispatchesLocker: Locker,
    private readonly events: Map<string, CreatedEvent>,
    private readonly dispatches: Map<string, Dispatch>,
  ) {}

  async createEvents(
    events: NewEvent[],
  ): Promise<Result<CreatedEvent[], "INTERNAL_SERVER_ERROR">> {
    const created = events.map((e): CreatedEvent => {
      let id: string;
      while (true) {
        id = crypto.randomUUID();
        if (!this.events.has(id)) break;
      }
      return createdEvent(id, e);
    });

    // Save events lazily.
    for (const e of created) {
      this.eventSink.set(e.id, e);
    }

    return ok(created);
  }

  async createDispatches(
    dispatches: NewDispatch[],
  ): Promise<Result<OngoingDispatch[], "INTERNAL_SERVER_ERROR">> {
    const created = dispatches.map((d): OngoingDispatch => {
      if (!this.events.has(d.eventId) && !this.eventSink.has(d.eventId)) {
        throw new Error("event not found");
      }

      let id: string;
      while (true) {
        id = crypto.randomUUID();
        if (!this.dispatches.has(id)) break;
      }
      return ongoingDispatch(id, d);
    });

    // Save dispatches lazily.
    for (const d of created) {
      this.dispatchSink.set(d.id, d);
    }

    return ok(created);
  }

  async saveDispatch(
    dispatch: Dispatch,
  ): Promise<Result<void, "INTERNAL_SERVER_ERROR">> {
    const v =
      this.dispatches.get(dispatch.id) || this.dispatchSink.get(dispatch.id);
    if (!v) {
      throw new Error("dispatch not found");
    }

    const clone = structuredClone(dispatch);
    clone.executionLog.forEach((e, i) => {
      if (isNewDispatchExecution(e)) {
        // @ts-ignore
        clone.executionLog[i] = dispatchExecution(
          crypto.randomUUID(),
          e.result,
          e.executedAt,
        );
      }
    });

    // Save dispatch lazily.
    this.dispatchSink.set(clone.id, clone);

    return ok((() => {})());
  }

  async getTargetDispatch(
    dispatchId: string,
  ): Promise<
    Result<
      { event: CreatedEvent; dispatch: Dispatch } | null,
      "INTERNAL_SERVER_ERROR"
    >
  > {
    const release = await this.dispatchesLocker.lock(dispatchId);
    this.releases.unshift(release);

    const v = this.dispatches.get(dispatchId);
    if (!v) {
      return ok(null);
    }
    const event = this.events.get(v.eventId) || this.eventSink.get(v.eventId);
    if (!event) {
      throw new Error("event not found");
    }
    return ok({ event, dispatch: v });
  }

  commit() {
    for (const [id, event] of this.eventSink) {
      this.events.set(id, event);
    }
    for (const [id, dispatch] of this.dispatchSink) {
      this.dispatches.set(id, dispatch);
    }
  }
  release() {
    for (const rel of this.releases) {
      rel();
    }
  }
}
