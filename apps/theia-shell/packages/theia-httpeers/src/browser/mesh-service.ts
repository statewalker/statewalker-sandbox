import { createMounts, type MeshView } from "@statewalker/httpeers-core";
import type { MemberHandle, PeerSession, SessionState } from "@statewalker/httpeers-member";
import { createSession } from "@statewalker/httpeers-member/browser";
import { ContributionProvider } from "@theia/core/lib/common/contribution-provider";
import { type Disposable, DisposableCollection } from "@theia/core/lib/common/disposable";
import { Emitter, type Event } from "@theia/core/lib/common/event";
import { inject, injectable, named } from "@theia/core/shared/inversify";
import { MeshContribution } from "../common/mesh-contribution";
import { isLoopbackHost, shellRules } from "../common/mesh-model";

/** The mount-prefix first segment and the ServiceWorker adapter key: every mesh URL is `/peers/<peerId>/…`. */
export const EDGE_KEY = "peers";
/**
 * `webrun-http-browser`'s ready-made worker, copied un-hashed into the app's
 * `lib/frontend/` by `app/esbuild.mjs`. The edge registers it by URL, and its
 * scope must cover `/peers/`, so the app is served from the origin root.
 */
export const SERVICE_WORKER_URL = "/sw.js";
/** The mesh view arrives on the heartbeat and nothing pushes it; this is how often it is re-read. */
const VIEW_POLL_MS = 2_000;

/**
 * This browser as a mesh member: the one `PeerSession` of the app.
 *
 * It owns the session, starts it when the app starts (so a `?join=` link
 * works on first load), and re-publishes the session's changes and the mesh
 * view as Theia events. Other extensions serve through `MeshContribution`
 * and call peers through `fetch` with a URL under `edgeBase`.
 */
@injectable()
export class MeshService implements Disposable {
  @inject(ContributionProvider)
  @named(MeshContribution)
  protected readonly contributions!: ContributionProvider<MeshContribution>;

  protected session: PeerSession | undefined;
  protected current: SessionState | null = null;
  protected viewVersion = -1;
  protected started: Promise<void> | undefined;
  protected readonly toDispose = new DisposableCollection();
  protected readonly onDidChangeEmitter = new Emitter<SessionState>();
  protected readonly onDidChangeViewEmitter = new Emitter<MeshView | null>();

  /** Every session change: phase, identity, the live handle. */
  readonly onDidChange: Event<SessionState> = this.onDidChangeEmitter.event;
  /** The mesh view changed (members, their roles, what they advertise). */
  readonly onDidChangeView: Event<MeshView | null> = this.onDidChangeViewEmitter.event;

  constructor() {
    this.toDispose.push(this.onDidChangeEmitter);
    this.toDispose.push(this.onDidChangeViewEmitter);
  }

  /** Creates and starts the session once; later calls return the same start. */
  start(): Promise<void> {
    this.started ??= this.doStart();
    return this.started;
  }

  protected async doStart(): Promise<void> {
    const mounts = createMounts();
    const contributions = this.contributions.getContributions();
    for (const contribution of contributions) contribution.configureMounts?.(mounts);
    const search = new URLSearchParams(location.search);
    this.session = createSession({
      key: EDGE_KEY,
      mounts,
      rules: shellRules(),
      advertisements: () => contributions.flatMap((c) => c.advertisements?.() ?? []),
      dev: isLoopbackHost(location.hostname) || search.get("meshDev") === "1",
      serviceWorkerUrl: SERVICE_WORKER_URL,
      // No `httpeers.json` here: the mesh always comes from an invitation or from memory.
      readDeploymentConfig: async () => null,
      onChange: (state) => this.changed(state),
    });
    const timer = setInterval(() => this.pollView(), VIEW_POLL_MS);
    this.toDispose.push({ dispose: () => clearInterval(timer) });
    this.changed(this.session.state());
    await this.session.start();
    this.dropJoinFromUrl();
  }

  /**
   * `?join=` is read once, at start; left in the address bar, a reload would
   * redeem the spent invitation again and be refused.
   */
  protected dropJoinFromUrl(): void {
    const url = new URL(location.href);
    if (!url.searchParams.has("join")) return;
    url.searchParams.delete("join");
    history.replaceState(history.state, "", url.href);
  }

  protected changed(state: SessionState): void {
    this.current = state;
    this.onDidChangeEmitter.fire(state);
    this.pollView();
  }

  protected pollView(): void {
    const view = this.meshView;
    const version = view?.version ?? -1;
    if (version === this.viewVersion) return;
    this.viewVersion = version;
    this.onDidChangeViewEmitter.fire(view);
  }

  /** The session, once `start()` has created it. */
  get peerSession(): PeerSession | undefined {
    return this.session;
  }

  get state(): SessionState | null {
    return this.current;
  }

  /** The live member, or `undefined` unless the phase is `live`. */
  get handle(): MemberHandle | undefined {
    return this.current?.handle ?? undefined;
  }

  get meshView(): MeshView | null {
    return this.handle?.meshView() ?? null;
  }

  get hubPeerId(): string | undefined {
    return this.handle?.hubPeerId;
  }

  /** `<origin>/peers/`: `fetch(edgeBase + peerId + "/path")` calls a peer through the ServiceWorker edge. */
  get edgeBase(): string | undefined {
    return this.handle?.baseUrl;
  }

  dispose(): void {
    this.toDispose.dispose();
  }
}
