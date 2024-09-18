import type { Result } from "neverthrow";

import type { Dispatch } from "../type";

export interface CreatedEvent {
  id: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface CreatedDispatch {
  eventId: string;
  id: string;
  destination: string;
  createdAt: Date;
  delaySeconds?: number;
}

export interface Persistence {
  /**
   * Enter transactional scope and call `fn`.
   * If `fn` returns `Err`, transaction must be aborted.
   * @param fn Transactional scope function
   */
  enterTransactionalScope: <T, E>(
    fn: (tx: Persistence) => Promise<Result<T, E>>,
  ) => Promise<Result<T, "INTERNAL_SERVER_ERROR" | E>>;

  /**
   * Save events.
   * @param events Events to be saved.
   * @returns Complete `CreatedEvent` with generated event ids.
   */
  saveEvents: (
    events: Omit<CreatedEvent, "id">[],
  ) => Promise<Result<CreatedEvent[], "INTERNAL_SERVER_ERROR">>;

  /**
   * Save dispatches.
   * @param dispatches Dispatches to be saved.
   * @return Complete `CreatedDispatch` with generated dispatch ids.
   */
  saveDispatches: (
    dispatches: Omit<CreatedDispatch, "id">[],
  ) => Promise<Result<CreatedDispatch[], "INTERNAL_SERVER_ERROR">>;

  /**
   * Find dispatch by given id.
   * @param dispatchId
   * @returns Either found dispatch or `"NOT_FOUND"` error.
   */
  getDispatch: (
    dispatchId: string,
  ) => Promise<Result<Dispatch, "INTERNAL_SERVER_ERROR" | "NOT_FOUND">>;

  updateDispatch: (
    dispatchId: string,
    status: "succeeded" | "ignored" | "failed" | "lost",
  ) => Promise<Result<void, "INTERNAL_SERVER_ERROR">>;
}
