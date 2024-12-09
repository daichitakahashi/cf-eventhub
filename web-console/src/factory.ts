import type { RpcEventHub } from "cf-eventhub";
import { createFactory } from "hono/factory";

export type DateTime = Date | Rpc.Provider<Date>;

export type Env = {
  Bindings: {
    EVENTHUB: Service<RpcEventHub>;
  };
  Variables: {
    dateFormatter: (d: DateTime) => string;
    dateRangeFormatter: (d1: DateTime, d2: DateTime) => string;
  };
};

export const factory = createFactory<Env>();
