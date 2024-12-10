import type { JSX } from "hono/jsx";

import type { Env } from "../factory";

export type ListDispatchesResult = Awaited<
  ReturnType<Env["Bindings"]["EVENTHUB"]["listDispatches"]>
>;

export type Dispatch = ListDispatchesResult["list"][number];

export type ListEventsResult = Awaited<
  ReturnType<Env["Bindings"]["EVENTHUB"]["listEvents"]>
>;

export type EventWithDispatches = ListEventsResult["list"][number];

export type ElementProps<Element extends keyof JSX.IntrinsicElements> =
  JSX.IntrinsicElements[Element];

// biome-ignore lint/complexity/noBannedTypes:
export type Node = {} | null | undefined;
