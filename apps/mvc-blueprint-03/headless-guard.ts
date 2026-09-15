import type { Plugin } from "vite";

/** What a headless project may never load: React, React DOM and the kit — by name or subpath. */
export const REACT_STACK = /^(react|react-dom|@statewalker\/ui\.view\.shadcn)(\/.*)?$/;

/** Fails resolution of the React stack in the Node project, naming the importer. */
export const headless = (project: string): Plugin => ({
  name: `mvc-blueprint-03:headless:${project}`,
  enforce: "pre",
  resolveId(source, importer) {
    if (!REACT_STACK.test(source)) return null;
    throw new Error(
      `headless stays headless: "${source}" was loaded by ${importer ?? "a suite"} in the ${project} project, ` +
        "which refuses React, react-dom and @statewalker/ui.view.shadcn.",
    );
  },
});
