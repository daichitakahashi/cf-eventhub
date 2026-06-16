import type { FC } from "hono/jsx";

import type { EventWithDeliveryJobs } from "./types";

export const StatusIndicator: FC<{
  status: EventWithDeliveryJobs["deliveryJobs"][number]["status"];
}> = ({ status }) => {
  let color = "fill-black";
  switch (status) {
    case "ongoing":
      color = "fill-yellow-500";
      break;
    case "completed":
      color = "fill-sky-500";
      break;
    case "failed":
      color = "fill-red-500";
      break;
    default:
      status satisfies never;
  }
  return (
    <svg class={`size-2 ${color}`} title="" role="img" aria-label>
      <circle cx="4" cy="4" r="4" />
    </svg>
  );
};
