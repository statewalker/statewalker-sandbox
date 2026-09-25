import { inject, injectable } from "@theia/core/shared/inversify";
import type { DeployedPlugin } from "@theia/plugin-ext/lib/common/plugin-protocol";
import { HostedPluginWatcher } from "@theia/plugin-ext/lib/hosted/browser/hosted-plugin-watcher";
import { BrowserOnlyHostedPluginServer } from "@theia/plugin-ext/lib/hosted/browser-only/browser-only-hosted-plugin-server";

/**
 * The browser-only hosted-plugin server serves a fixed list (list.json). This
 * one also accepts plugins at runtime: `deploy` adds one and fires the
 * watcher's `onDidDeploy`, which makes `HostedPluginSupport` sync and start it
 * — the path a backend deploy takes, with no reload.
 *
 * With a backend, the RPC proxy for `HostedPluginServer` is created with the
 * watcher's client. In browser-only mode the server is a plain class and
 * `setClient` is never called, so the watcher is injected here instead.
 */
@injectable()
export class RuntimePluginServer extends BrowserOnlyHostedPluginServer {
  @inject(HostedPluginWatcher)
  protected readonly watcher!: HostedPluginWatcher;

  private readonly runtime: DeployedPlugin[] = [];

  protected override async getPlugins(): Promise<DeployedPlugin[]> {
    return [...(await super.getPlugins()), ...this.runtime];
  }

  async deploy(plugin: DeployedPlugin): Promise<void> {
    this.runtime.push(plugin);
    this.watcher.getHostedPluginClient().onDidDeploy();
  }
}
