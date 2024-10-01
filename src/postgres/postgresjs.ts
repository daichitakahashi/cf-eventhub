import { Executor as BaseExecutor } from "../core/executor";
import { EventHub as BaseEventHub } from "../core/hub";
import { createRepository } from "./postgresjs-repository";

export class Executor extends BaseExecutor {
  protected async getRepository() {
    return createRepository(this.env);
  }
}

export class EventHub extends BaseEventHub {
  protected async getRepository() {
    return createRepository(this.env);
  }
}
