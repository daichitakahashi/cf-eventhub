import type { Env } from "../factory";

export type ListDispatchesResult = Awaited<
  ReturnType<Env["Bindings"]["EVENTHUB"]["listDispatches"]>
>;

export type Dispatch = ListDispatchesResult["list"][number];
