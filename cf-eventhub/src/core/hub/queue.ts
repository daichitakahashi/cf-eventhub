import { fromAsyncThrowable } from "neverthrow";

import { formatException } from "../../utils/format-exception";
import type { Logger } from "../logger";
import type { ConstantRetryDelay, ExponentialRetryDelay } from "./routing";

export type QueueMessage = {
  dispatchId: string;
  retryDelay: ConstantRetryDelay | ExponentialRetryDelay;
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
      logger.error("failed to Queue.sendBatch", { error: formatException(e) });
      return "INTERNAL_SERVER_ERROR" as const;
    },
  )();
