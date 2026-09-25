# P6: VS Code web extensions, static and at runtime

**Question.** Can a VS Code *web* extension (one with a `browser` entry) run in
Theia 1.76's browser-only plugin host? What is the seam a runtime installer
would replace?

**Answer: yes to both, with one workaround and one small subclass.**

## Static plugins (build time)

- Unpacked plugins go in `theiaPluginsDir` (`plugins-src/` here). `theia build`
  runs `prepareBrowserOnlyPlugins`, which copies each plugin to
  `lib/frontend/hostedPlugin/<publisher>_<name>/` and writes their
  `DeployedPlugin` metadata to `hostedPlugin/list.json`.
- At start-up, `BrowserOnlyHostedPluginServer` fetches `list.json`. The plugin
  host is a Web Worker (`plugin-worker.js`) that `importScripts` each plugin's
  entry by URL.
- `p6-hello`'s commands run, and `vscode.workspace.fs.readFile` reads
  `README.md` from the **FilesApi**: the plugin API ends at our
  `FileSystemProvider`.

**Workaround: declare `activationEvents` explicitly.** VS Code infers
`onCommand:*` from `contributes.commands`. Theia's browser-only build runs
`updateActivationEvents` only on the copy it normalizes for `list.json`, but the
worker reads the plugin's *raw* `package.json`, whose `activationEvents: []`
stays empty. The command is listed in the palette, but running it never
activates the plugin, and `extension.js` is never fetched. With
`"activationEvents": ["onCommand:p6.hello", …]` it works. This looks like a
Theia 1.76 bug worth reporting upstream.

## Runtime deploy (no reload)

[`extension/src/runtime-plugin-server.ts`](extension/src/runtime-plugin-server.ts):

```ts
@injectable()
export class RuntimePluginServer extends BrowserOnlyHostedPluginServer {
  @inject(HostedPluginWatcher) protected readonly watcher!: HostedPluginWatcher;
  private readonly runtime: DeployedPlugin[] = [];
  protected override async getPlugins() { return [...(await super.getPlugins()), ...this.runtime]; }
  async deploy(plugin: DeployedPlugin) {
    this.runtime.push(plugin);
    this.watcher.getHostedPluginClient().onDidDeploy();   // → HostedPluginSupport.load()
  }
}
// module: rebind(HostedPluginServer).toService(RuntimePluginServer)
```

- `onDidDeploy` makes `HostedPluginSupport` sync the ids, load the new
  contributions and start the plugin in the running worker. The command then
  appears and runs, with no reload.
- **Finding: in browser-only mode nobody calls `setClient`** on the hosted-plugin
  server. With a backend, the RPC proxy is created with the watcher's client;
  the browser-only server is a plain class. So `getClient()` is `undefined`,
  and the server must reach the `HostedPluginWatcher` directly. The first
  attempt, which used `getClient()?.onDidDeploy()`, was red for that reason.
- `scripts/prepare-late-plugins.mjs` stands in for an installer. It runs the
  same `prepareBrowserOnlyPlugins` on `late-plugins-src/`, puts the files next
  to the static ones, and writes the metadata to `late-plugins.json` instead of
  `list.json`. The page reads it and calls `deploy`.

## What a real installer still needs

1. **Serve the plugin's files from a URL the worker can load.** Today they are
   static files. At runtime they would come from a `FilesApi` (OPFS) or a mesh
   peer, served under `hostedPlugin/<id>/` by a Service Worker. That is exactly
   what `webrun-http-browser`'s `SwHttpAdapter.register(prefix, handler)` does.
2. **Build the `DeployedPlugin` metadata in the browser.** The model, lifecycle
   and activation events come from `@theia/plugin-utils/lib/common`, which is
   browser-safe. `normalizeContributions` and grammar reading are in
   `lib/node`, which is Node-only. So either the publisher ships the prepared
   metadata (signed), or the node-only parts are ported.
3. **Undeploy and persistence:** keep the installed list in IndexedDB, and on
   uninstall remove the entry and fire `onDidDeploy` again.

## Costs

- `@theia/plugin-ext` pulls in 27 more frontend modules (55 against 28): tasks,
  debug, terminal, SCM, test, notebook, AI/MCP and more. Several of them call
  their missing backend services and raise page errors (`getTasks`,
  `debugTypes`, `getRunningServers`, …), and the *Run* and *Terminal* menus
  appear. The P6 test deliberately does not assert "no page errors". The full
  app should either do without plugins or trim these modules.
- `bundle.js` grows from 24 MB to 30 MB, plus a 7.9 MB `plugin-worker.js`.
- Plugin state creates a **`.theia/` folder in the workspace root**, which is
  written into the FilesApi and shows up in the explorer.

## Red / green

- Red 1: not built.
- Red 2: built, but the commands did nothing. `extension.js` was never
  requested: the activation-events finding.
- Green: static plugins, 2 of 2.
- Red 3: runtime deploy, no `late-plugins.json` (not implemented).
- Red 4: runtime deploy with `getClient()?.onDidDeploy()`, the command never
  appeared: the `setClient` finding.
- Green: `3 passed (16.4s)`.
