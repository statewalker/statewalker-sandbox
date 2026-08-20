/**
 * The ServiceWorker edge: mounts a peer's `dispatch` into
 * `@statewalker/webrun-http-browser`'s `SwHttpAdapter` so a page's own
 * `fetch()` (same-origin) can reach it, no different in shape from any
 * other HTTP request on the page.
 *
 * `dispatch` MOUNTS UNCHANGED -- NO WRAPPER, NO CAST (design note 22 §1,
 * criterion 1 of prototype E-1). `httpeers.core`'s `FetchHandler` is
 * `(Request) => Promise<Response>`; `SwHttpAdapter.register`'s `HttpHandler`
 * (`@statewalker/webrun-http-streams`) is `(Request) => Response |
 * Promise<Response>` -- the same contract, arrived at independently, which
 * is exactly why `mountEdge` below passes `dispatch` straight through with
 * no adapter of its own.
 *
 * THE KEY/PREFIX TRAP -- see `edge-guard.ts`'s `assertKeyMatchesPrefix` for
 * the mechanism and why it is factored into its own file.
 *
 * WORKSPACE IMPORT, NOT NPM (design note 39 "Published 0.3.3 and workspace
 * 0.3.3 are different artefacts"). `SwHttpAdapter` does not exist in the
 * published npm tarball's dist bundle at all -- `src/sw/index.js` is
 * absent there, the re-export is commented out, and the deep import fails
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. `package.json` pins
 * `@statewalker/webrun-http-browser: workspace:*` for exactly this reason.
 * The WORKSPACE package's own `package.json` still points its `./sw`
 * export at `./dist/sw.js`, and that package ships no committed `dist/`
 * (gitignored, `workspaces/webrun-wire/.gitignore`) -- so this import only
 * resolves once `pnpm --filter @statewalker/webrun-http-browser build` (or
 * an equivalent `turbo build` that reaches it) has actually run. This is
 * the known defect the task brief calls out; see this task's report for
 * exactly what was verified and how.
 */
import type { FetchHandler } from "@statewalker/httpeers.core";
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import { assertKeyMatchesPrefix } from "./edge-guard.js";

export { assertKeyMatchesPrefix };

export interface MountEdgeInit {
  /** The ServiceWorker adapter's channel key -- see `assertKeyMatchesPrefix`'s doc comment for why this must equal `prefix`'s first path segment. */
  key: string;
  /** Defaults to `${key}/` -- the one prefix shape `assertKeyMatchesPrefix` is guaranteed to accept. Overridable only for a caller with a real reason to diverge. */
  prefix?: string;
  serviceWorkerUrl?: string;
  /** The peer's own router. Mounted unchanged -- see this module's doc comment. */
  dispatch: FetchHandler;
}

export interface EdgeHandle {
  /** The URL a same-origin `fetch()` reaches this peer's `dispatch` through. */
  baseUrl: string;
  stop(): Promise<void>;
}

/**
 * Register a peer's `dispatch` on the ServiceWorker edge. Throws (via
 * `assertKeyMatchesPrefix`) before `SwHttpAdapter` is even constructed if
 * `key`/`prefix` disagree -- the failure this function exists to make
 * loud instead of silent.
 */
export async function mountEdge(init: MountEdgeInit): Promise<EdgeHandle> {
  const prefix = init.prefix ?? `${init.key}/`;
  assertKeyMatchesPrefix(init.key, prefix);

  const adapter = new SwHttpAdapter({ key: init.key, serviceWorkerUrl: init.serviceWorkerUrl });
  await adapter.start();
  const registration = await adapter.register(prefix, init.dispatch);

  return {
    baseUrl: registration.baseUrl,
    async stop() {
      await registration.remove();
      await adapter.stop();
    },
  };
}
