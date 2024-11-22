import { Queue, WorkersCronTrigger } from "@pulumi/cloudflare";
import { type Input, jsonStringify } from "@pulumi/pulumi";

import type { Config, ConfigInput } from "../../core/hub/routing";

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

/**
 * Resource constructor of event handler worker script.
 */
export type HandlerWorkerScript<W> = {
  /**
   * Worker script name.
   */
  readonly name: string;
  /**
   * Constructor of the handler worker script.
   * @param name Value of `HandlerWorkerScript.name`
   * @param eventHub Input value that can be used to bind EventHub worker script.
   * @returns Created worker script.
   */
  workerScript(name: string, eventHub: ServiceBindingInput): W;
  /**
   * Input value for Service Bindings setting of Executor to bind created handler worker script.
   */
  readonly binding: Omit<HandlerWorkerScriptBinding, "service">;
};

/**
 * Creates cached version of given script.
 * This is useful when the same HandlerWorkerScript is attached to multiple route conditions.
 * @param script Original HandlerWorkerScript.
 * @returns Cached version of given script.
 */
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

type HandlerRoute<W> = Omit<ConfigInput["routes"][number], "destination"> & {
  destination: HandlerWorkerScript<W>;
};

type WorkerScript = {
  name: Input<string>;
};

export type EventHubArgs<W extends WorkerScript> = Omit<Config, "routes"> & {
  /**
   * Account ID of Cloudflare.
   */
  accountId: Input<string>;
  /**
   * Prefix for Queue and workers script name(EventHub, Executor).
   */
  name: Input<string>;
  /**
   * Routing configuration of event handling.
   */
  routes: HandlerRoute<W>[];
  /**
   * Cron expressions to mark dispatches lost.
   */
  markDispatchesLostSchedules: Input<Input<string>[]>;
};

export type CreateEventHubWorkerScriptArgs = {
  /**
   * Account ID of Cloudflare.
   */
  accountId: Input<string>;
  /**
   * Worker script name.
   */
  name: Input<string>;
  /**
   * Input value that should be used for binding created Queue to EventHub.
   */
  queueBinding: QueueBindingInput;
  /**
   * Input value that should be used for binding routing configuration to EventHub.
   */
  routeConfigBinding: TextBindingInput;
};

export type CreateExecutorWorkerScriptArgs = {
  /**
   * Account ID of Cloudflare.
   */
  accountId: Input<string>;
  /**
   * Worker script name.
   */
  name: Input<string>;
  /**
   * Input value that should be used for binding handlers to Executor.
   */
  handlerBindings: HandlerWorkerScriptBinding[];
};

type CreateQueueConsumerArgs = {
  /**
   * Account ID of Cloudflare.
   */
  accountId: Input<string>;
  /**
   * Queue name.
   */
  queue: Input<string>;
  /**
   * Executor worker script name.
   */
  executor: Input<string>;
  /**
   * Default delay seconds derived from `EventHubArgs`.
   */
  defaultDelaySeconds?: Input<number>;
  /**
   * Default max retries derived from `EventHubArgs`.
   */
  defaultMaxRetries?: Input<number>;
};

export abstract class EventHub<
  _WorkerScript extends WorkerScript,
  _QueueConsumer = unknown,
> {
  queue: Queue;
  queueConsumer: _QueueConsumer | undefined;
  eventHub: _WorkerScript;
  cronTrigger: WorkersCronTrigger;
  executor: _WorkerScript;
  handlers: Record<string, _WorkerScript>;

  constructor(
    /**
     * Prefix for resource names of Queue and Worker scripts(EventHub, Executor).
     */
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

    const cronTrigger = new WorkersCronTrigger(`${name}:cronTrigger`, {
      accountId: args.accountId,
      schedules: args.markDispatchesLostSchedules,
      scriptName: eventHub.name,
    });

    this.queue = queue;
    this.queueConsumer = consumer;
    this.eventHub = eventHub;
    this.cronTrigger = cronTrigger;
    this.executor = executor;
    this.handlers = handlers;
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
