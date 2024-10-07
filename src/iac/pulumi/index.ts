import { Queue } from "@pulumi/cloudflare";
import { type Input, jsonStringify } from "@pulumi/pulumi";

import type { Config, Route } from "../../core/hub/routing";

export type HandlerWorkerScriptBinding = {
  readonly name: Input<string>;
  readonly service: Input<string>;
  readonly entrypoint?: Input<string>;
};

export type ServiceBindingInput = {
  readonly service: Input<string>;
  readonly entrypoint?: Input<string>;
};

export type TextBindingInput = {
  readonly name: Input<string>;
  readonly text: Input<string>;
};

export type QueueBindingInput = {
  readonly name: Input<string>;
  readonly queueName: Input<string>;
};

export type HandlerWorkerScript<W> = {
  readonly name: string;
  workerScript(name: string, eventHub: ServiceBindingInput): W;
  readonly binding: Omit<HandlerWorkerScriptBinding, "service">;
};

export const handlerWorkerScriptRef = <W>(
  script: HandlerWorkerScript<W>,
): HandlerWorkerScript<W> => {
  let w: W;
  return {
    ...script,
    workerScript(name, eventHub) {
      if (w === undefined) {
        w = script.workerScript(name, eventHub);
      }
      return w;
    },
  };
};

type HandlerRoute<W> = Omit<Route, "destination"> & {
  destination: HandlerWorkerScript<W>;
};

type WorkerScript = {
  name: Input<string>;
};

export type EventHubArgs<W extends WorkerScript> = Omit<Config, "routes"> & {
  accountId: Input<string>;
  name: Input<string>;
  routes: HandlerRoute<W>[];
};

export type CreateEventHubWorkerScriptArgs = {
  accountId: Input<string>;
  name: Input<string>;
  queueBinding: QueueBindingInput;
  routeConfigBinding: TextBindingInput;
};

export type CreateExecutorWorkerScriptArgs = {
  accountId: Input<string>;
  name: Input<string>;
  handlerBindings: HandlerWorkerScriptBinding[];
};

type CreateQueueConsumerArgs = {
  accountId: Input<string>;
  queue: Input<string>;
  executor: Input<string>;
  defaultDelaySeconds?: Input<number>;
  defaultMaxRetries?: Input<number>;
};

export abstract class EventHub<
  _WorkerScript extends WorkerScript,
  _QueueConsumer = unknown,
> {
  queue: Queue;
  queueConsumer: _QueueConsumer | undefined;
  eventHub: _WorkerScript;
  executor: _WorkerScript;

  constructor(
    public name: string,
    args: EventHubArgs<_WorkerScript>,
  ) {
    const queue = new Queue(`${name}:queue`, {
      accountId: args.accountId,
      name: `${args.name}-queue`,
    });

    // Create event hub(WorkerScript).
    const routeConfig = args.routes.map((r) => ({
      ...r,
      destination: r.destination.binding.name, // binding name
    }));
    const eventHub = this.createEventHubWorkerScript(`${name}:eventHub`, {
      accountId: args.accountId,
      name: `${args.name}-eventHub`,
      queueBinding: {
        name: "EVENTHUB_QUEUE",
        queueName: queue.name,
      },
      routeConfigBinding: {
        name: "EVENTHUB_ROUTING",
        text: jsonStringify({
          defaultDelaySeconds: args.defaultDelaySeconds,
          defaultMaxRetries: args.defaultMaxRetries,
          routes: routeConfig,
        }),
      },
    });

    // Create all handlers(WorkerScript).
    const handlers: Record<string, _WorkerScript> = {};
    const handlerBindings = args.routes.map((r): HandlerWorkerScriptBinding => {
      const scriptName = r.destination.name;
      handlers[scriptName] = r.destination.workerScript(scriptName, {
        service: eventHub.name,
      });
      return {
        ...r.destination.binding,
        service: scriptName,
      };
    });

    // Create executor(WorkerScript).
    const executor = this.createExecutorWorkerScript(`${name}:executor`, {
      accountId: args.accountId,
      name: `${args.name}-executor`,
      handlerBindings,
    });

    // Create Queue consumer.
    const consumer = this.createQueueConsumer(`${name}:queueConsumer`, {
      accountId: args.accountId,
      queue: queue.name,
      executor: executor.name,
      defaultDelaySeconds: args.defaultDelaySeconds,
      defaultMaxRetries: args.defaultMaxRetries,
    });

    this.queue = queue;
    this.queueConsumer = consumer;
    this.eventHub = eventHub;
    this.executor = executor;
  }

  abstract createEventHubWorkerScript(
    name: string,
    args: CreateEventHubWorkerScriptArgs,
  ): _WorkerScript;

  abstract createExecutorWorkerScript(
    name: string,
    args: CreateExecutorWorkerScriptArgs,
  ): _WorkerScript;

  protected createQueueConsumer(
    _name: string,
    _args: CreateQueueConsumerArgs,
  ): _QueueConsumer | undefined {
    return undefined;
  }
}
