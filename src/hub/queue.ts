import { fromAsyncThrowable } from "neverthrow";

export type QueueMessage = {
  dispatchId: string;
};

export const enqueue = (
  queue: Queue,
  messages: MessageSendRequest<QueueMessage>[],
) =>
  fromAsyncThrowable(
    () => queue.sendBatch(messages),
    (e) => {
      console.error("failed to Queue.sendBatch", e);
      return "INTERNAL_SERVER_ERROR" as const;
    },
  )();
