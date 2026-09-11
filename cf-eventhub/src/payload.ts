/**
 * Resolves the originating stub without making an RPC call.
 * Returns undefined for missing metadata or an invalid ID for this namespace.
 * Only instanceId is required; deliveryJobId is validated by reportFailure().
 */
export function getEventHubFromPayload<T extends Rpc.DurableObjectBranded>(
  namespace: DurableObjectNamespace<T>,
  payload: unknown,
): DurableObjectStub<T> | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return undefined;
  const metadata = (payload as Record<string, unknown>).__eventhub__;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  )
    return undefined;

  const instanceId = (metadata as Record<string, unknown>).instanceId;
  if (typeof instanceId !== "string" || instanceId.length === 0)
    return undefined;

  try {
    const id = namespace.idFromString(instanceId);
    return namespace.get(id);
  } catch {
    return undefined;
  }
}
