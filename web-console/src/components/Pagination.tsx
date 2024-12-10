import type { FC } from "hono/jsx";

import type { DateTime } from "../factory";
import { ChevronRight, ChevronsLeft } from "./Icon";
import type { ElementProps } from "./types";

const PaginationSection: FC<ElementProps<"nav">> = (props) => (
  <nav
    aria-label="pagination"
    class="mx-auto flex w-full justify-center"
    {...props}
  />
);

const PaginationContent: FC<ElementProps<"ul">> = (props) => (
  <ul class="flex flex-row items-center gap-2" {...props} />
);

const PaginationItem: FC<ElementProps<"li">> = (props) => <li {...props} />;

const PaginationLink: FC<ElementProps<"a">> = (props) => (
  <a
    class={`
      h-10
      px-4
      py-2
      border
      rounded-md
      flex
      gap-1
      items-center
      select-none
      ${props.href ? "text-black hover:bg-gray-100" : "text-gray-500 bg-gray-100"}`}
    {...props}
  />
);

const PaginationLabel: FC<ElementProps<"span">> = (props) => (
  <span
    class="
      h-10
      px-4
      py-2
      border
      rounded-md
      flex
      gap-1
      items-center
      select-none
    "
    {...props}
  />
);

export const Pagination: FC<{
  topUrl?: string;
  nextUrl?: string;
  range?: [Date] | [Date, Date];
  formatDateRange: (d1: DateTime, d2: DateTime) => string;
}> = ({ topUrl, nextUrl, range, formatDateRange }) => (
  <PaginationSection>
    <PaginationContent>
      <PaginationItem>
        <PaginationLink aria-label="Go to latest page" href={topUrl}>
          <ChevronsLeft class="size-4" title="" />
          <span>Latest</span>
        </PaginationLink>
      </PaginationItem>
      <PaginationItem>
        {range && (
          <PaginationLabel>
            {range.length === 1
              ? formatDateRange(range[0], range[0])
              : formatDateRange(range[0], range[1])}
          </PaginationLabel>
        )}
      </PaginationItem>
      <PaginationItem>
        <PaginationLink aria-label="Go to next page" href={nextUrl}>
          <span>Next</span>
          <ChevronRight class="size-4" title="" />
        </PaginationLink>
      </PaginationItem>
    </PaginationContent>
  </PaginationSection>
);
