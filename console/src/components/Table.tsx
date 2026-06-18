import type { ElementProps } from "./types";

export const Table = (props: ElementProps<"table">) => (
  <div class="relative w-full overflow-auto">
    <table class={"w-full caption-bottom text-sm"} {...props} />
  </div>
);

export const TableHeader = (props: ElementProps<"thead">) => (
  <thead class={"[&>tr]:border-b"} {...props} />
);

export const TableBody = (props: ElementProps<"tbody">) => (
  <tbody class="[&>tr:last-child]:border-0" {...props} />
);

export const TableRow = (props: ElementProps<"tr">) => (
  <tr
    class="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted"
    {...props}
  />
);

export const TableHead = (props: ElementProps<"th">) => (
  <th
    class="h-12 px-4 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0"
    {...props}
  />
);

export const TableCell = (props: ElementProps<"td">) => (
  <td class="p-4 align-middle [&:has([role=checkbox])]:pr-0" {...props} />
);
