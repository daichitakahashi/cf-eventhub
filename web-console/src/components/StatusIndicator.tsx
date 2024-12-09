import type { FC } from "hono/jsx";

export const StatusIndicator: FC<{ status: "ongoing" | "complete" }> = ({
  status,
}) => (
  <svg
    class={`size-2 ${status === "complete" ? "fill-sky-500" : "fill-green-500"}`}
    title=""
    role="img"
    aria-label
  >
    <circle cx="4" cy="4" r="4" />
  </svg>
);
