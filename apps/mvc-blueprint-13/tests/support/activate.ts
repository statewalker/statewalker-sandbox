import { type Context, type Controller, newScope } from "@p5/kernel";

/** Activates ONE bundle outside a loader, in its own bundle scope; returns its stop. */
export async function activateAlone(
  activate: Controller,
  context: Context,
): Promise<() => Promise<void>> {
  const scope = newScope(undefined, true);
  const cleanup = await activate(context, scope);
  if (cleanup) scope.defer(cleanup);
  return () => scope.close();
}
