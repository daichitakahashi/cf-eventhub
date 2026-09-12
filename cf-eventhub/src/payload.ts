/**
 * Resolves the originating stub without making an RPC call.
 * Returns undefined for missing metadata or an invalid ID for this namespace.
 * A valid instanceName is preferred so named instances retain their name when
 * invoked. Only instanceId is required; deliveryJobId is validated separately.
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
    const instanceName = (metadata as Record<string, unknown>).instanceName;
    if (instanceName === undefined) return namespace.get(id);
    if (typeof instanceName !== "string" || instanceName.length === 0)
      return undefined;
    if (namespace.idFromName(instanceName).toString() !== instanceId)
      return undefined;
    return namespace.getByName(instanceName);
  } catch {
    return undefined;
  }
}
