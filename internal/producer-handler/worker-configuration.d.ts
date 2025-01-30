import type { RpcEventHub } from "cf-eventhub";

export type Env = {
  EVENTHUB: Service<RpcEventHub>;
};
