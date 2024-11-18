import { createFactory } from "hono/factory";

import type { RpcEventHub } from "../../cf-eventhub/src/core/hub/rpc";

export type Env = {
  Bindings: {
    EVENT_HUB: Service<RpcEventHub>;
  };
};

export const factory = createFactory<Env>();
