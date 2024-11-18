import type { Env } from "../factory";

export type ListDispatchesResult = Awaited<
  ReturnType<Env["Bindings"]["EVENT_HUB"]["listDispatches"]>
>;

export type Dispatch = ListDispatchesResult["list"][number];
