import type { HttpService } from "./http-service.js";
import { newServiceAdapter } from "./service-adapter.js";

export const [consumeHttpService, newHttpServiceProvider, removeHttpService] = newServiceAdapter<
  HttpService,
  Record<string, unknown>
>("service:http", getRootContext);

export function provideHttpService(context: Record<string, unknown>, service: HttpService) {
  const [provideService, removeService] = newHttpServiceProvider(context);
  provideService(service);
  return removeService;
}

// --------------------------------------------
// Inner utility functions

function getRootContext(context: Record<string, unknown>): Record<string, unknown> {
  let rootContext: Record<string, unknown> | undefined = context as Record<string, unknown>;
  while (typeof rootContext?.parent === "object") {
    rootContext = rootContext.parent as Record<string, unknown>;
  }
  return rootContext as Record<string, unknown>;
}
