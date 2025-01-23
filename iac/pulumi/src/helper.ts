import { RunError, log } from "@pulumi/pulumi";
import type { Config } from "cf-eventhub/core";

type Handler = { service: string; entrypoint?: string | undefined };
type Destination<C extends Config> = C["routes"][number]["destination"];

/**
 * Helper to construct EventHub and its Executor
 */
export class EventHubHelper<C extends Config = Config> {
  destinations: Map<Destination<C>, Handler | null>;

  /**
   * @param config Configuration of EventHub routing. This is re-exported from `EventHubHelper.config`.
   * @param strict If true, an error is thrown when a bound handler is not found.
   */
  constructor(
    public config: C,
    private strict: boolean,
  ) {
    this.destinations = config.routes.reduce((acc, route) => {
      acc.set(route.destination, null);
      return acc;
    }, new Map<Destination<C>, Handler | null>());
  }

  /**
   * Assign handler for the destination.
   * Handler should be found in the config.
   * @param destination
   * @param handler
   * @returns
   */
  public assignHandler(destination: Destination<C>, handler: Handler) {
    const d = this.destinations.get(destination);
    if (d === undefined) {
      log.warn(
        `EventHubHelper: destination ${destination} is not found in the config.`,
      );
      return;
    }
    if (!d) {
      this.destinations.set(destination, handler);
    }
  }

  /**
   * Get all registered handlers.
   * If there are destinations that are not assigned, it will log a warning or throw error.
   * @returns Array of handler bindings.
   */
  public getHandlers() {
    const handlers = [...this.destinations.entries()];
    const notRegistered = handlers
      .filter(([, handler]) => handler === null)
      .map(([destination]) => destination);
    if (notRegistered.length > 0) {
      const message =
        notRegistered.length === 1
          ? `EventHubHelper: destination ${notRegistered[0]} is not registered.`
          : `EventHubHelper: destinations ${notRegistered.join(", ")} are not registered.`;
      if (this.strict) {
        throw new RunError(message);
      }
      log.warn(message);
    }
    return handlers
      .filter((h): h is [string, Handler] => h[1] !== null)
      .map(([destination, { service, entrypoint }]) => ({
        binding: destination,
        service,
        entrypoint,
      }));
  }
}
