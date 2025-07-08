import type { FC } from "hono/jsx";

import type { ElementProps } from "./types";

export const Button: FC<ElementProps<"button"> & { secondary?: boolean }> = ({
  secondary,
  ...props
}) => (
  <button
    class={`
      rounded-lg
      px-3
      py-1
      min-h-10
      align-middle
      ${!secondary ? "text-white bg-black/90 hover:bg-black/80" : "text-black bg-gray-100 hover:bg-gray-200/70"}
      select-none
      disabled:text-gray-500
      disabled:bg-gray-100
      disabled:cursor-default
    `}
    {...props}
  />
);
