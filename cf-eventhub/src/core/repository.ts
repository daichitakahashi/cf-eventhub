import type { Result } from "neverthrow";

import type {
  CreatedEvent,
  Dispatch,
  Event,
  NewDispatch,
  NewEvent,
  OngoingDispatch,
} from "./model";

export type EventWithDispatches = Event & {
  readonly dispatches: readonly Dispatch[];
};

export interface Repository {
  /**
   * Enter transactional scope and call `fn`.
   * If `fn` returns `Err`, transaction must be aborted.
   * @param fn Transactional scope function
   */
  mutate: <T, E>(
    fn: (tx: MutationRepository) => Promise<Result<T, E>>,
  ) => Promise<Result<T, "INTERNAL_SERVER_ERROR" | E>>;

  /**
   * Get event by given id.
   * @param eventId
   * @returns Found `Event`.
   */
  readEvent: (
    eventId: string,
  ) => Promise<Result<EventWithDispatches | null, "INTERNAL_SERVER_ERROR">>;

  /**
   * Get dispatches.
   * @param maxItems maximum number of items to be fetched
   * @param continuationToken token returned in last call
   * @param filterByStatus
   * @param orderBy
   * @returns
   */
  readDispatches: (
    maxItems: number,
    continuationToken?: string,
    filterByStatus?: Dispatch["status"][],
    orderBy?: "CREATED_AT_ASC" | "CREATED_AT_DESC",
  ) => Promise<
    Result<
      { list: Dispatch[]; continuationToken?: string },
      "INTERNAL_SERVER_ERROR" | "INVALID_CONTINUATION_TOKEN"
    >
  >;

  /**
   * Get events and these dispatches.
   * @param maxItems maximum number of items to be fetched
   * @param continuationToken token returned in last call
   * @param orderBy
   */
  readEvents(
    maxItems: number,
    continuationToken?: string,
    orderBy?: "CREATED_AT_ASC" | "CREATED_AT_DESC",
  ): Promise<
    Result<
      { list: EventWithDispatches[]; continuationToken?: string },
      "INTERNAL_SERVER_ERROR" | "INVALID_CONTINUATION_TOKEN"
    >
  >;
}

export interface MutationRepository {
  /**
   * Create events.
   * @param events Events to be created.
   * @returns `CreatedEvent` with event ids.
   */
  createEvents: (
    events: NewEvent[],
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
   */
  saveDispatch: (
    dispatch: Dispatch,
  ) => Promise<Result<void, "INTERNAL_SERVER_ERROR">>;

  /**
   * Get dispatch which is a target of mutation by given id.
   * @param dispatchId
   * @returns Found `Dispatch` and associated `CreatedEvent`.
   */
  getTargetDispatch: (
    dispatchId: string,
  ) => Promise<
    Result<
      { event: CreatedEvent; dispatch: Dispatch } | null,
      "INTERNAL_SERVER_ERROR"
    >
  >;
}
