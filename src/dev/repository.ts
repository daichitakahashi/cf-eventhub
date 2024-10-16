import { Mutex } from "async-mutex";
import { type Result, err, ok } from "neverthrow";

import {
  type CreatedEvent,
  type Dispatch,
  type NewDispatch,
  type NewEvent,
  type OngoingDispatch,
  createdEvent,
  dispatchExecution,
  isNewDispatchExecution,
  ongoingDispatch,
} from "../core/model";
import type { Repository } from "../core/repository";

export class DevRepository implements Repository {
  private mu: Mutex;
  private events: Map<string, CreatedEvent>;
  private dispatches: Map<string, { index: number; dispatch: Dispatch }>;

  constructor(repo?: DevRepository) {
    this.mu = new Mutex();
    this.events = repo ? structuredClone(repo.events) : new Map();
    this.dispatches = repo ? structuredClone(repo.dispatches) : new Map();
  }

  async enterTransactionalScope<T, E>(
    fn: (tx: Repository) => Promise<Result<T, E>>,
  ): Promise<Result<T, "INTERNAL_SERVER_ERROR" | E>> {
    return this.mu.runExclusive(async () => {
      const tx = new DevRepository(this);

      let result: Result<T, "INTERNAL_SERVER_ERROR" | E>;
      try {
        result = await fn(tx);
      } catch {}

      // @ts-ignore
      if (!result) {
        return err("INTERNAL_SERVER_ERROR" as const);
      }
      if (result.isOk()) {
        this.events = tx.events;
        this.dispatches = tx.dispatches;
      }

      return result;
    });
  }

  async createEvents(
    events: NewEvent[],
  ): Promise<Result<CreatedEvent[], "INTERNAL_SERVER_ERROR">> {
    return this.mu.runExclusive(async () => {
      const created = events.map((e): CreatedEvent => {
        let id: string;
        while (true) {
          id = crypto.randomUUID();
          if (!this.events.has(id)) break;
        }
        return createdEvent(id, e);
      });
      for (const e of created) {
        this.events.set(e.id, e);
      }

      return ok(created);
    });
  }

  async createDispatches(
    dispatches: NewDispatch[],
  ): Promise<Result<OngoingDispatch[], "INTERNAL_SERVER_ERROR">> {
    return this.mu.runExclusive(async () => {
      const created = dispatches.map((d): OngoingDispatch => {
        if (!this.events.has(d.eventId)) {
          throw new Error("event not found");
        }

        let id: string;
        while (true) {
          id = crypto.randomUUID();
          if (!this.dispatches.has(id)) break;
        }
        return ongoingDispatch(id, d);
      });
      for (const d of created) {
        this.dispatches.set(d.id, {
          index: this.dispatches.size,
          dispatch: d,
        });
      }

      return ok(created);
    });
  }

  async saveDispatch(
    dispatch: Dispatch,
  ): Promise<Result<void, "INTERNAL_SERVER_ERROR">> {
    return this.mu.runExclusive(async () => {
      const v = this.dispatches.get(dispatch.id);
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

      this.dispatches.set(clone.id, {
        index: v.index,
        dispatch: clone,
      });
      return ok((() => {})());
    });
  }

  async getDispatch(
    dispatchId: string,
  ): Promise<
    Result<
      { event: CreatedEvent; dispatch: Dispatch } | null,
      "INTERNAL_SERVER_ERROR"
    >
  > {
    const v = this.dispatches.get(dispatchId);
    if (!v) {
      return ok(null);
    }
    const event = this.events.get(v.dispatch.eventId);
    if (!event) {
      throw new Error("event not found");
    }
    return ok({ event, dispatch: v.dispatch });
  }

  async listOngoingDispatches(
    maxItems: number,
    continuationToken?: string,
  ): Promise<
    Result<
      { list: OngoingDispatch[]; continuationToken?: string },
      "INTERNAL_SERVER_ERROR"
    >
  > {
    const values = [...this.dispatches.values()];

    let lastIndex = 0;
    if (continuationToken) {
      const last = this.dispatches.get(
        decodeContinuationToken(continuationToken),
      );
      if (!last) {
        return err("INTERNAL_SERVER_ERROR");
      }
      lastIndex = last.index;
    }

    const list = lastIndex ? values.slice(lastIndex + 1) : values;
    const result: OngoingDispatch[] = [];
    for (const { dispatch } of list) {
      if (dispatch.status !== "ongoing") {
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
}

const encodeContinuationToken = (id: string) => btoa(id);

const decodeContinuationToken = (token: string) => atob(token);
