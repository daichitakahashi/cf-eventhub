import type { FC } from "hono/jsx";

import type { Dispatch } from "./types";

const statusColor = (status: Dispatch["status"]) => {
  switch (status) {
    case "ongoing":
      return "is-info is-light";
    case "ignored":
      return "is-white";
    case "complete":
      return "is-success is-light";
    case "failed":
      return "is-danger";
    case "lost":
      return "is-danger";
    case "misconfigured":
      return "is-danger";
    default:
      return "is-light";
  }
};

interface Props {
  status: Dispatch["status"];
  size?: "small" | "normal";
}

export const DispatchStatus: FC<Props> = ({ status, size }) => (
  <span
    class={`tag ${statusColor(status)} is-medium has-text-weight-medium px-2 py-1`}
    style={{
      height: size === "small" ? "1em" : undefined,
      borderRadius: "1em",
    }}
  >
    {status}
  </span>
);
