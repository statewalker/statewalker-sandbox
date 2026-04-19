import { getAdapter } from "@statewalker/shared-adapters";

// --------------------------------------------
// Service primitive (was: @repo/shared/services/new-services.ts)

// Registers a new service consumer callback and returns a cleanup function
export type ServiceConsumer<T> = (callback: (values: T[]) => void) => () => void;

// Registers a new service provider and returns two functions:
// - provideService: updates the service value
// - removeProvider: unregisters the provider
export type ServiceProvider<T> = (
  intialValue?: T,
) => [provideService: (service: T) => void, removeService: () => void];

function newService<T>(): [ServiceConsumer<T>, ServiceProvider<T>] {
  let consumerId = 0;
  const consumerIndex: Record<number, (values: T[]) => void> = {};
  let providerId = 0;
  const valuesIndex: Record<number, T> = {};

  const notifyConsumers = () => {
    const values = Object.values(valuesIndex);
    for (const consumer of Object.values(consumerIndex)) {
      consumer(values);
    }
  };

  const newConsumer: ServiceConsumer<T> = (callback) => {
    const id = consumerId++;
    callback(Object.values(valuesIndex));
    consumerIndex[id] = callback;
    return () => delete consumerIndex[id];
  };

  const newProvider: ServiceProvider<T> = (initialValue?: T) => {
    const id = providerId++;
    let provideService = (value: T) => {
      valuesIndex[id] = value;
      notifyConsumers();
    };
    let removeService = () => {
      provideService = () => {};
      removeService = () => {};
      delete valuesIndex[id];
      notifyConsumers();
    };
    initialValue !== undefined && provideService(initialValue);
    return [(value: T) => provideService(value), () => removeService()];
  };
  return [newConsumer, newProvider];
}

// --------------------------------------------
// Context-scoped service adapter (was: @repo/shared/services/new-service-adapter.ts)

export function newContextServiceAdapter<T, C = unknown>(
  extensionKey: string,
): [
  newServiceConsumer: (context: C, callback: (values: T[]) => void) => () => void,
  newServiceProvider: (
    context: C,
    intialValue?: T,
  ) => [provideService: (service: T) => void, removeService: () => void],
  removeContextService: (context: C) => void,
] {
  const [getService, removeService] = getAdapter<[ServiceConsumer<T>, ServiceProvider<T>], C>(
    extensionKey,
    () => newService<T>(),
  );

  function newServiceConsumer(context: C, callback: (values: T[]) => void): () => void {
    const [getConsumer] = getService(context);
    return getConsumer(callback);
  }

  function newServiceProvider(
    context: C,
    intialValue?: T,
  ): [provideService: (service: T) => void, removeService: () => void] {
    const [, provideService] = getService(context);
    return provideService(intialValue);
  }

  function removeContextService(context: C) {
    return removeService(context);
  }

  return [newServiceConsumer, newServiceProvider, removeContextService];
}

export function newServiceAdapter<T, C = Record<string, unknown>>(
  extensionKey: string,
  getRootContext: (context: C) => C = (context) => {
    let rootContext = context;
    while (rootContext) {
      if (typeof rootContext !== "object" || !("parent" in rootContext)) {
        break;
      }
      rootContext = rootContext.parent as C;
    }
    return rootContext;
  },
): [
  newServiceConsumer: (context: C, callback: (values: T[]) => void) => () => void,
  newServiceProvider: (
    context: C,
    intialValue?: T,
  ) => [provideService: (service: T) => void, removeService: () => void],
  removeContextService: (context: C) => void,
] {
  const [newServiceConsumer, newServiceProvider, removeContextService] = newContextServiceAdapter<
    T,
    C
  >(extensionKey);
  return [
    (context, callback) => newServiceConsumer(getRootContext(context), callback),
    (context, initialValue) => newServiceProvider(getRootContext(context), initialValue),
    (context) => removeContextService(getRootContext(context)),
  ];
}
