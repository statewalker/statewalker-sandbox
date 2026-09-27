import { type JoinWidget, mountJoinWidget, shortPeerId } from "@statewalker/httpeers-join";
import type { ConnectionKind } from "@statewalker/httpeers-member";
import { ClipboardService } from "@theia/core/lib/browser/clipboard-service";
import { ConfirmDialog } from "@theia/core/lib/browser/dialogs";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { type PeerRow, peerRows } from "../common/mesh-model";
import { MeshService } from "./mesh-service";

/**
 * The Mesh view: the join widget every httpeers page shares (paste or scan
 * an invitation, the hub link, disconnect, reconnect, leave, and for an
 * admin, invite others), then the peers of the mesh and what each serves.
 */
@injectable()
export class MeshWidget extends ReactWidget {
  static readonly ID = "httpeers-mesh";
  static readonly LABEL = "Mesh";

  @inject(MeshService) protected readonly mesh!: MeshService;
  @inject(ClipboardService) protected readonly clipboard!: ClipboardService;

  protected join: JoinWidget | undefined;

  @postConstruct()
  protected init(): void {
    this.id = MeshWidget.ID;
    this.title.label = MeshWidget.LABEL;
    this.title.caption = "httpeers mesh: membership and peers";
    this.title.iconClass = "codicon codicon-broadcast";
    this.title.closable = true;
    this.addClass("httpeers-mesh-widget");
    this.scrollOptions = { suppressScrollX: true };
    this.toDispose.push(
      this.mesh.onDidChange((state) => {
        this.join?.update(state);
        this.update();
      }),
    );
    // The join widget reads this member's roles from the mesh view (whether to
    // offer the Invite panel), and the view arrives on a heartbeat, after the
    // session went live: it is told about both.
    this.toDispose.push(
      this.mesh.onDidChangeView(() => {
        this.join?.update(this.mesh.state);
        this.update();
      }),
    );
    this.toDispose.push({ dispose: () => this.join?.destroy() });
    void this.mesh.start();
    this.update();
  }

  /**
   * The join widget is plain DOM with its own state, so it is created once and
   * kept across React renders: the ref callback below only moves it in.
   */
  protected joinElement(): HTMLElement | undefined {
    const session = this.mesh.peerSession;
    if (session == null) return undefined;
    this.join ??= mountJoinWidget(document.createElement("div"), {
      session,
      state: this.mesh.state,
      confirm: (message) =>
        new ConfirmDialog({ title: "Mesh", msg: message, ok: "Continue" })
          .open()
          .then((ok) => ok === true),
      invite: {},
    });
    return this.join.element;
  }

  protected readonly attachJoin = (host: HTMLDivElement | null): void => {
    const element = this.joinElement();
    if (host != null && element != null && element.parentElement !== host) host.append(element);
  };

  protected render(): React.ReactNode {
    const hubPeerId = this.mesh.hubPeerId ?? null;
    const rows = peerRows(this.mesh.meshView, hubPeerId);
    const handle = this.mesh.handle;
    return (
      <div className="httpeers-mesh">
        <section className="httpeers-mesh-join" aria-label="Membership">
          <div ref={this.attachJoin} />
          {this.mesh.state?.identity != null && (
            <p className="httpeers-mesh-self">
              This browser is{" "}
              <code title={this.mesh.state.identity}>{shortPeerId(this.mesh.state.identity)}</code>
            </p>
          )}
        </section>
        <section className="httpeers-mesh-peers" aria-label="Peers">
          <h3>Peers {rows.length > 0 && <span className="httpeers-count">{rows.length}</span>}</h3>
          {rows.length === 0 ? (
            <p className="httpeers-muted">Join a mesh to see its peers.</p>
          ) : (
            <ul>
              {rows.map((row) =>
                this.renderPeer(
                  row,
                  row.isSelf ? null : (handle?.connectionKind(row.peerId) ?? null),
                ),
              )}
            </ul>
          )}
        </section>
      </div>
    );
  }

  protected renderPeer(row: PeerRow, link: ConnectionKind | null): React.ReactNode {
    return (
      <li key={row.peerId} className="httpeers-peer" data-peer={row.peerId}>
        <div className="httpeers-peer-head">
          <span
            className={`httpeers-dot ${row.online ? "online" : "offline"}`}
            title={row.online ? "online" : "offline"}
          />
          <button
            type="button"
            className="httpeers-peer-id"
            title={`${row.peerId} (click to copy)`}
            onClick={() => this.clipboard.writeText(row.peerId)}
          >
            {shortPeerId(row.peerId)}
          </button>
          {row.isSelf && <span className="httpeers-badge self">you</span>}
          {row.isHub && <span className="httpeers-badge hub">hub</span>}
          {row.roles.map((role) => (
            <span key={role} className="httpeers-badge role">
              {role}
            </span>
          ))}
          {link != null && link !== "none" && <span className="httpeers-link">{link}</span>}
        </div>
        {row.services.length > 0 && (
          <div className="httpeers-services">
            {row.services.map((service) => (
              <span
                key={service.id}
                className="httpeers-service"
                title={`${service.kind} · ${service.id}`}
              >
                {service.title || service.id}
              </span>
            ))}
          </div>
        )}
      </li>
    );
  }
}
