// Conditional ESM module loading (Node.js and browser)
if (!globalThis.URLPattern) {
  await import("urlpattern-polyfill");
}

import { DEFAULT_HTTP_SERVICE_PRIORITY, type HttpService } from "./http-service.js";
import { consumeHttpService } from "./http-service-adapter.js";

/**
 * Creates a new HTTP service dispatcher that routes incoming requests to the appropriate HTTP service
 * based on URL patterns and HTTP methods. Services are prioritized based on their defined priority.
 *
 * @param context - The context object used to consume HTTP services.
 * @returns A tuple containing the fetch function to handle requests and a remove function to clean up.
 */
export function newHttpServiceDispatcher(
  context: Record<string, unknown>,
): [fetch: (request: Request) => Promise<Response>, remove: () => void] {
  let handlersMapping: [URLPattern, HttpService][] = [];
  const defaultPriority = DEFAULT_HTTP_SERVICE_PRIORITY;
  const remove = consumeHttpService(context, (services) => {
    handlersMapping = services.map((service) => {
      const urlPattern = new URLPattern({ pathname: service.path });
      return [urlPattern, service];
    });
    handlersMapping = handlersMapping.sort(([, a], [, b]) => {
      const prioA = a.priority ?? defaultPriority;
      const prioB = b.priority ?? defaultPriority;
      return prioB - prioA;
    });
  });
  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    for (const [pattern, service] of handlersMapping) {
      const serviceMethod = (service.method ?? "ALL").toUpperCase();
      const methodMatch = serviceMethod === "ALL" || serviceMethod === req.method;
      if (methodMatch && pattern.test(url)) {
        return service.fetch(req);
      }
    }
    return new Response(`No handler for ${req.method} ${url.pathname}`, {
      status: 404,
    });
  };
  return [fetch, remove];
}
