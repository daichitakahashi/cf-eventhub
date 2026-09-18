import type { EventHubErrorCode } from "cf-eventhub";

export const eventHubErrorMessages: Record<EventHubErrorCode, string> = {
  INVALID_ARGUMENT:
    "The request was rejected because one or more arguments are invalid.",
  PAYLOAD_TOO_LARGE:
    "The event exceeds the 128,000-byte Cloudflare Queues message size limit.",
  INVALID_CURSOR: "The request contains an invalid pagination cursor.",
  DESTINATION_NOT_CONFIGURED:
    "A destination used by this event is not configured.",
  INVALID_DESTINATION_BINDING:
    "A destination binding is not configured as a Queue or R2 bucket.",
  INSTANCE_MISMATCH: "The request targets a different EventHub instance.",
};

export const operationErrorTitles = {
  "publish-failed": "Failed to publish event.",
  "redrive-failed": "Failed to redrive delivery job.",
} as const;

export const unexpectedOperationErrorMessage =
  "The operation failed unexpectedly. Check Workers Logs for details.";

export const getEventHubErrorCode = (
  error: unknown,
): EventHubErrorCode | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const code = (error as Record<string, unknown>).code;
    return typeof code === "string" &&
      Object.prototype.hasOwnProperty.call(eventHubErrorMessages, code)
      ? (code as EventHubErrorCode)
      : undefined;
  } catch {
    return undefined;
  }
};
