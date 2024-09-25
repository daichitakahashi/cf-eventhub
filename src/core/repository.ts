import type { Result } from "neverthrow";

import type {
  CreatedEvent,
  Dispatch,
  NewDispatch,
  NewEvent,
  OngoingDispatch,
} from "./model";

export interface Repository {
  /**
   * Enter transactional scope and call `fn`.
   * If `fn` returns `Err`, transaction must be aborted.
   * @param fn Transactional scope function
   */
  enterTransactionalScope: <T, E>(
    fn: (tx: Repository) => Promise<Result<T, E>>,
  ) => Promise<Result<T, "INTERNAL_SERVER_ERROR" | E>>;

  /**
   * Create events.
   * @param events Events to be created.
   * @returns `CreatedEvent` with event ids.
   */
  createEvents: (
    events: Omit<NewEvent, "id">[],
  ) => Promise<Result<CreatedEvent[], "INTERNAL_SERVER_ERROR">>;

  /**
   * Create dispatches.
   * @param dispatches Dispatches to be created.
   * @returns Created `OngoingDispatch` with dispatch ids.
   */
  createDispatches: (
    dispatches: NewDispatch[],
  ) => Promise<Result<OngoingDispatch[], "INTERNAL_SERVER_ERROR">>;

  /**
   * Update dispatches.
   * @param dispatches Dispatches to be updated.
   * @return Updated `Dispatch`.
   */
  saveDispatch: (
    dispatch: Dispatch,
  ) => Promise<Result<Dispatch, "INTERNAL_SERVER_ERROR">>;

  /**
   * Get dispatch by given id.
   * @param dispatchId
   * @returns Found `Dispatch`.
   */
  getDispatch: (
    dispatchId: string,
  ) => Promise<Result<Dispatch, "INTERNAL_SERVER_ERROR">>;
}
