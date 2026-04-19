const RPC_SERVICES_KEY = "rpc:service-registry";

type RpcRegistry = {
  [serviceName: string]: unknown;
};

/**
 * Retrieves the RPC registry from a context object.
 *
 * @param context - The context object containing the registry
 * @returns The RPC registry object
 */
export function getRpcRegistry<C = Record<string, unknown>>(context: C): RpcRegistry {
  const ctx = context as Record<string, unknown>;
  let registry = ctx[RPC_SERVICES_KEY] as RpcRegistry | undefined;
  if (!registry) {
    registry = {};
    ctx[RPC_SERVICES_KEY] = registry;
  }
  return registry;
}

/**
 * Removes the entire RPC registry from a context object.
 *
 * @param context - The context object containing the registry
 */
export function removeRpcRegistry<C = Record<string, unknown>>(context: C): void {
  const ctx = context as Record<string, unknown>;
  delete ctx[RPC_SERVICES_KEY];
}

/**
 * Creates a new RPC adapter for a specific service type.
 * This factory function returns methods to manage individual RPC services within the global registry.
 *
 * @param name - The unique name/key for the RPC service in the registry
 * @returns A tuple of [getRpc, setRpc, removeRpc] functions for managing the specific service
 */
export function newRpcAdapter<T, C = Record<string, unknown>>(
  name: string,
): [(context: C) => T | undefined, (context: C, fun: T) => void, (context: C) => void] {
  /**
   * Retrieves the RPC service instance from the registry.
   *
   * @param context - The context object containing the registry
   * @returns The RPC service instance of type T
   */
  function getRpc(context: C) {
    const registry = getRpcRegistry(context);
    return registry[name] as T | undefined;
  }

  /**
   * Stores an RPC service instance in the registry.
   *
   * @param context - The context object containing the registry
   * @param fun - The RPC service instance to store
   */
  function setRpc(context: C, fun: T) {
    const registry = getRpcRegistry(context);
    registry[name] = fun;
  }

  /**
   * Removes an RPC service instance from the registry.
   *
   * @param context - The context object containing the registry
   */
  function removeRpc(context: C) {
    const registry = getRpcRegistry(context);
    delete registry[name];
  }

  return [getRpc, setRpc, removeRpc] as const;
}
