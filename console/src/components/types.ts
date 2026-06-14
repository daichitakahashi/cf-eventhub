import type { JSX } from "hono/jsx";

export type {
  ConsoleDispatch as Dispatch,
  ConsoleEvent as EventWithDispatches,
} from "../eventhub";

export type ElementProps<Element extends keyof JSX.IntrinsicElements> =
  JSX.IntrinsicElements[Element];
