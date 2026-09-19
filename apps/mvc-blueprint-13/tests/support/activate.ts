import { type Context, type Controller, newScope } from "@p5/kernel";

/** Activates ONE bundle outside a loader, in its own bundle scope; returns its stop. */
export async function activateAlone(
  activator: Controller,
  context: Context,
): Promise<() => Promise<void>> {
  const scope = newScope();
  const cleanup = await activator(context, scope);
  if (cleanup) scope.defer(cleanup);
  return () => scope.close();
}
