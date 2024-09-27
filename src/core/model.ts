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
  readonly delaySeconds: number | null;
  readonly maxRetryCount: number;
}

export interface OngoingDispatch extends NewDispatch {
  id: string;
  readonly [brand]: "ongoing";
  readonly status: "ongoing";
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
  readonly id: string;
}

export const isNewDispatchExecution = (
  d: DispatchExecution | NewDispatchExecution,
): d is NewDispatchExecution => brand in d && d[brand] !== "created";

export type Dispatch = OngoingDispatch | ResultedDispatch;

export const isResultedDispatch = (d: Dispatch): d is ResultedDispatch =>
  d.status !== "ongoing";

// Constructor of CreatedEvent
export const createdEvent = (id: string, event: NewEvent): CreatedEvent => ({
  ...event,
  [brand]: "created",
  id,
});

// Constructor of OngoingDispatch
export const ongoingDispatch = (
  id: string,
  dispatch: NewDispatch,
): OngoingDispatch => ({
  ...dispatch,
  [brand]: "ongoing",
  id,
  status: "ongoing",
  executionLog: [],
});

export const appendExecutionLog = (
  dispatch: OngoingDispatch,
  execution: NewDispatchExecution,
): Dispatch => {
  if (execution.result === "notfound") {
    return dispatch;
  }

  const status =
    execution.result !== "failed" ||
    dispatch.executionLog.length + 1 > dispatch.maxRetryCount
      ? execution.result
      : ("ongoing" as const);
  const executionLog =
    dispatch.executionLog.length > 0
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

export const makeDispatchLost = (
  d: OngoingDispatch,
  resultedAt: Date,
): ResultedDispatch => ({
  ...d,
  [brand]: "resulted",
  status: "lost",
  resultedAt,
});
