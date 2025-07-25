import type { ElementProps } from "./types";

export const Textarea = (props: ElementProps<"textarea">) => {
  return (
    <textarea
      {...props}
      class="
        flex
        min-h-[80px]
        max-h-[300px]
        w-full
        rounded-md
        border
        border-input
        px-3
        py-2
        ring-offset-background
        placeholder:text-muted-foreground
        focus-visible:outline-none
        focus-visible:ring-2
        focus-visible:ring-ring
        focus-visible:ring-offset-2
        disabled:cursor-not-allowed
        disabled:opacity-50
        md:text-sm
        read-only:bg-gray-100
        read-only:border-none
      "
    />
  );
};
