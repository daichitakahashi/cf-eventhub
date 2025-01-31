import { fromAsyncThrowable } from "neverthrow";

import type { Logger } from "../logger";

export type QueueMessage = {
  dispatchId: string;
  delaySeconds?: number;
};

/** @internal */
export const enqueue = (
  queue: Queue,
  messages: MessageSendRequest<QueueMessage>[],
  logger: Logger,
) =>
  fromAsyncThrowable(
    () => queue.sendBatch(messages),
    (e) => {
      logger.error("failed to Queue.sendBatch", { error: e });
      return "INTERNAL_SERVER_ERROR" as const;
    },
  )();
