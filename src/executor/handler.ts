import { WorkerEntrypoint } from "cloudflare:workers";

export class Handler extends WorkerEntrypoint {
  async handle(
    eventPayload: Record<string, unknown>,
  ): Promise<"complete" | "ignored" | "failed"> {
    throw new Error("not implemented");
  }
}
