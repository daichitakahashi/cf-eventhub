import type { Result } from "neverthrow";

import type { EventPayload, ExecutionResult } from "../type";

const brand = Symbol();

// Properties of newly created event;
export interface NewEvent {
  readonly payload: EventPayload;
  readonly createdAt: Date;
}

export interface CreatedEvent extends NewEvent {
  readonly [brand]: "created";
  readonly id: string;
}

// Properties of newly created dispatch.
export interface NewDispatch {
  readonly eventId: string;
  readonly destination: string;
  readonly createdAt: Date;
  readonly delaySeconds?: number;
  readonly maxRetryCount: number;
}

export interface OngoingDispatch extends NewDispatch {
  id: string;
  readonly [brand]: "ongoing";
  readonly status: "ongoing";
  readonly payload: EventPayload;
  readonly executionLog: readonly (DispatchExecution | NewDispatchExecution)[];
}

export interface ResultedDispatch
  extends Omit<OngoingDispatch, typeof brand | "status"> {
  readonly [brand]: "resulted";
  readonly status: "complete" | "ignored" | "failed" | "misconfigured" | "lost";
  readonly resultedAt: Date;
}

export interface NewDispatchExecution {
  readonly result: ExecutionResult;
  readonly executedAt: Date;
}

export interface DispatchExecution
  extends Omit<NewDispatchExecution, typeof brand> {
  readonly [brand]: "created";
}

export const isNewDispatchExecution = (
  d: DispatchExecution | NewDispatchExecution,
): d is NewDispatchExecution => brand in d && d[brand] !== "created";

type Dispatch = OngoingDispatch | ResultedDispatch;

export const isResultedDispatch = (d: Dispatch): d is ResultedDispatch =>
  d.status !== "ongoing";

export const appendExecutionLog = (
  dispatch: OngoingDispatch,
  execution: NewDispatchExecution,
): Dispatch => {
  if (execution.result === "notfound") {
    return dispatch;
  }

  const status =
    execution.result !== "failed" ||
    dispatch.executionLog.length + 1 >= dispatch.maxRetryCount
      ? execution.result
      : ("ongoing" as const);
  const executionLog = dispatch.executionLog.length
    ? [...dispatch.executionLog, execution]
    : [execution];

  if (status === "ongoing") {
    return {
      ...dispatch,
      [brand]: "ongoing",
      status: "ongoing",
      executionLog,
    };
  }
  return {
    ...dispatch,
    [brand]: "resulted",
    status,
    executionLog,
    resultedAt: execution.executedAt,
  };
};

export const makeDispatchLost = (d: OngoingDispatch): ResultedDispatch => ({
  ...d,
  [brand]: "resulted",
  status: "lost",
  resultedAt: new Date(),
});

export interface Persistence {
  saveDispatchExecutionResult(id: string, result: string): unknown;
  /**
   * Enter transactional scope and call `fn`.
   * If `fn` returns `Err`, transaction must be aborted.
   * @param fn Transactional scope function
   */
  enterTransactionalScope: <T, E>(
    fn: (tx: Persistence) => Promise<Result<T, E>>,
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
