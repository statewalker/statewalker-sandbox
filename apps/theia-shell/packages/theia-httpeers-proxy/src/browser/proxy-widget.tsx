import { shortPeerId } from "@statewalker/httpeers-join";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { MeshService } from "@theia-shell/theia-httpeers/lib/browser/mesh-service";
import { PROXY_ADVERT, PROXY_MOUNT, ProxyService } from "./proxy-service";

/** Where the test console sends a request: this browser's own table, or a peer's proxy over the mesh. */
const LOCAL = "local";

interface Draft {
  prefix: string;
  upstream: string;
  secretHeader: string;
  secretValue: string;
}

const EMPTY: Draft = { prefix: "", upstream: "", secretHeader: "", secretValue: "" };

/**
 * The proxy's route table and a test console.
 *
 * Routes expose an outside origin to the mesh under `/proxy/<prefix>/`. A
 * credential header's NAME is saved with the route; its VALUE is kept for
 * this session only and must be typed again after a reload.
 *
 * The console calls this browser's table IN PROCESS: a member calling its
 * own mount through its own edge is refused (`peer-binding`), because no
 * connection proved who is calling. A peer's proxy is called over the mesh.
 */
@injectable()
export class ProxyWidget extends ReactWidget {
  static readonly ID = "httpeers-proxy";
  static readonly LABEL = "Mesh Proxy";

  @inject(ProxyService) protected readonly proxy!: ProxyService;
  @inject(MeshService) protected readonly mesh!: MeshService;

  protected draft: Draft = { ...EMPTY };
  protected status = "";
  protected target = LOCAL;
  protected method = "GET";
  protected path = "/";
  protected output: string | undefined;

  @postConstruct()
  protected init(): void {
    this.id = ProxyWidget.ID;
    this.title.label = ProxyWidget.LABEL;
    this.title.caption = "Expose outside HTTP origins to the mesh";
    this.title.iconClass = "codicon codicon-arrow-swap";
    this.title.closable = true;
    this.addClass("httpeers-proxy-widget");
    this.toDispose.push({ dispose: this.proxy.table.onChange(() => this.update()) });
    this.toDispose.push(this.mesh.onDidChangeView(() => this.update()));
    void this.proxy.ready.then(() => this.update());
  }

  protected set(patch: Partial<Draft>): void {
    this.draft = { ...this.draft, ...patch };
    this.update();
  }

  protected async add(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const { prefix, upstream, secretHeader, secretValue } = this.draft;
    try {
      await this.proxy.table.add({
        prefix: prefix.trim(),
        upstream: upstream.trim(),
        secretHeader,
        secretValue,
      });
      this.status = `Added ${prefix.trim()}.`;
      this.draft = { ...EMPTY };
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
    this.update();
  }

  /** Other peers that advertise a proxy. */
  protected peerProxies(): string[] {
    const view = this.mesh.meshView;
    if (view == null) return [];
    return view.advertisements
      .filter((ad) => ad.kind === PROXY_ADVERT.kind && ad.peerId !== view.self)
      .map((ad) => ad.peerId);
  }

  protected async send(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const path = this.path.startsWith("/") ? this.path : `/${this.path}`;
    this.output = "sending…";
    this.update();
    try {
      let response: Response;
      if (this.target === LOCAL) {
        await this.proxy.ready;
        response = await this.proxy.table.handle(
          new Request(`http://proxy.local${path}`, { method: this.method }),
        );
      } else {
        const base = this.mesh.edgeBase;
        if (base == null) throw new Error("Not connected to a mesh.");
        response = await fetch(`${base}${this.target}${PROXY_MOUNT}${path}`, {
          method: this.method,
        });
      }
      const body = await response.text();
      this.output = `${response.status} ${response.statusText}\n\n${body.slice(0, 4000)}`;
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error);
    }
    this.update();
  }

  protected render(): React.ReactNode {
    const routes = this.proxy.table.routes();
    const self = this.mesh.state?.identity;
    const peers = this.peerProxies();
    if (this.target !== LOCAL && !peers.includes(this.target)) this.target = LOCAL;
    return (
      <div className="httpeers-proxy">
        <p className="httpeers-muted">
          Other members reach a route at{" "}
          <code>
            /peers/{self == null ? "<this peer>" : shortPeerId(self)}/proxy/&lt;prefix&gt;/…
          </code>
          . The mesh's own headers (membership token, proven peer) are stripped before anything
          leaves for the upstream.
        </p>
        <h3>Routes</h3>
        <table className="httpeers-proxy-routes" aria-label="Routes">
          <thead>
            <tr>
              <th>Prefix</th>
              <th>Upstream</th>
              <th>Credential</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {routes.length === 0 ? (
              <tr>
                <td colSpan={4} className="httpeers-muted">
                  No routes yet.
                </td>
              </tr>
            ) : (
              routes.map((route) => (
                <tr key={route.prefix}>
                  <td>
                    <code>{route.prefix}</code>
                  </td>
                  <td>
                    <code>{route.upstream}</code>
                  </td>
                  <td>
                    {route.secretHeader == null
                      ? "—"
                      : this.proxy.table.hasSecret(route.prefix)
                        ? `${route.secretHeader} ✓`
                        : `${route.secretHeader} (re-enter after reload)`}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="theia-button secondary"
                      onClick={() => void this.proxy.table.remove(route.prefix)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <form
          className="httpeers-proxy-form"
          onSubmit={(e) => void this.add(e)}
          aria-label="Add a route"
        >
          <label>
            Prefix
            <input
              className="theia-input"
              placeholder="/api"
              value={this.draft.prefix}
              onChange={(e) => this.set({ prefix: e.target.value })}
            />
          </label>
          <label>
            Upstream URL
            <input
              className="theia-input"
              placeholder="https://api.example.com/v1"
              value={this.draft.upstream}
              onChange={(e) => this.set({ upstream: e.target.value })}
            />
          </label>
          <label>
            Credential header
            <input
              className="theia-input"
              placeholder="authorization (optional)"
              value={this.draft.secretHeader}
              onChange={(e) => this.set({ secretHeader: e.target.value })}
            />
          </label>
          <label>
            Credential value
            <input
              className="theia-input"
              type="password"
              placeholder="kept in memory only"
              autoComplete="off"
              value={this.draft.secretValue}
              onChange={(e) => this.set({ secretValue: e.target.value })}
            />
          </label>
          <button type="submit" className="theia-button">
            Add route
          </button>
          <span className="httpeers-proxy-status" role="status">
            {this.status}
          </span>
        </form>

        <h3>Try it</h3>
        <form
          className="httpeers-proxy-console"
          onSubmit={(e) => void this.send(e)}
          aria-label="Test console"
        >
          <select
            className="theia-select"
            aria-label="Target"
            value={this.target}
            onChange={(e) => {
              this.target = e.target.value;
              this.update();
            }}
          >
            <option value={LOCAL}>This browser (in process)</option>
            {peers.map((peer) => (
              <option key={peer} value={peer}>
                Peer {shortPeerId(peer)} (over the mesh)
              </option>
            ))}
          </select>
          <select
            className="theia-select"
            aria-label="Method"
            value={this.method}
            onChange={(e) => {
              this.method = e.target.value;
              this.update();
            }}
          >
            {["GET", "POST", "PUT", "DELETE"].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input
            className="theia-input"
            aria-label="Path"
            value={this.path}
            onChange={(e) => {
              this.path = e.target.value;
              this.update();
            }}
          />
          <button type="submit" className="theia-button">
            Send
          </button>
        </form>
        {this.output != null && <pre className="httpeers-proxy-output">{this.output}</pre>}
      </div>
    );
  }
}
