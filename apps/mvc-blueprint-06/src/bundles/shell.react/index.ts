/**
 * `shell.react` — the React host actor. Owns the `ui.react:renderers` point, mounts the host into
 * the DOM root it was configured with, and publishes the coverage report.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { type BundleManifest, defineStream, ownPoints } from "../../kernel/index.js";
import { dialogs, panels } from "../shell/api/index.js";
import { reactRenderers, SHELL_REACT } from "../shell/api/react.js";
import { Host } from "./host.js";

export interface Coverage {
  /** Published panels and dialogs whose kind has no React renderer. */
  readonly unrendered: readonly { point: string; id: string; kind: string }[];
}
export const coverage = defineStream<Coverage>("ui.react:coverage");

export function shellReactBundle(options: { root: HTMLElement }): BundleManifest {
  return {
    id: SHELL_REACT,
    behavior: (ctx) => {
      const points = ownPoints(ctx, [reactRenderers]);
      const report = () => {
        const kinds = new Set((ctx.read(reactRenderers.key) ?? []).map((r) => r.value.kind));
        const unrendered = [
          ...(ctx.read(panels.key) ?? []).map((c) => ({
            point: panels.key as string,
            id: c.id,
            kind: c.value.kind,
          })),
          ...(ctx.read(dialogs.key) ?? []).map((c) => ({
            point: dialogs.key as string,
            id: c.id,
            kind: c.value.kind,
          })),
        ].filter((u) => !kinds.has(u.kind));
        ctx.publish(coverage, { unrendered });
      };
      ctx.subscribe(panels.key, report);
      ctx.subscribe(dialogs.key, report);
      ctx.subscribe(reactRenderers.key, report);
      const root = createRoot(options.root);
      root.render(createElement(Host, { port: ctx.viewPort() }));
      ctx.onStop(() => root.unmount());
      return (msg, env) => {
        if (!points.handle(msg, env)) ctx.log.warn("the React host ignores a message", msg);
      };
    },
  };
}
