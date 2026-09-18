import { setReactRoot } from "../bundles/shell/api/react.js";
import type { Context } from "../kernel/context.js";
import { type ApplicationManifest, application } from "../kernel/loader.js";

/** Activates an application on a fresh context, mounting the React host on `element`. */
export async function startApp(
  manifest: ApplicationManifest,
  element: HTMLElement,
  setup?: (context: Context) => void,
): Promise<{ context: Context; stop: () => Promise<void> }> {
  const context: Context = {};
  setReactRoot(context, element);
  setup?.(context);
  const stop = await application(manifest)(context);
  return { context, stop: async () => void (await stop?.()) };
}
