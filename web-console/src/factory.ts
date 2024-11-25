import type { RpcEventHub } from "cf-eventhub";
import { createFactory } from "hono/factory";

export type Env = {
  Bindings: {
    EVENT_HUB: Service<RpcEventHub>;
  };
  Variables: {
    dateFormatter: (d: Date | Rpc.Provider<Date>) => string;
  };
};

export const factory = createFactory<Env>();
