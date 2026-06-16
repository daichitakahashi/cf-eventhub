import type { JSX } from "hono/jsx";

export type {
  ConsoleDeliveryJob as DeliveryJob,
  ConsoleEvent as EventWithDeliveryJobs,
} from "../eventhub";

export type ElementProps<Element extends keyof JSX.IntrinsicElements> =
  JSX.IntrinsicElements[Element];
