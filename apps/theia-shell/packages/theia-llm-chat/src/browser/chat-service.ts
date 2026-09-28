import { Emitter, type Event } from "@theia/core/lib/common/event";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import { MeshService } from "@theia-shell/theia-httpeers/lib/browser/mesh-service";
import {
  type ChatSetup,
  type ChatSource,
  createChatSetup,
  type MeshLink,
} from "../common/chat-setup";
import {
  type ChatController,
  createChatController,
  endpointClient,
} from "../common/core/chat-controller";
import { resolveModel } from "../common/core/config";
import { idbConfigStore, idbSessionStore } from "../common/core/idb";
import type { SessionStore, SessionSummary } from "../common/core/sessions";

const SOURCE_KEY = "theia-shell:llm-chat:source";

/** Wrapped, never passed bare: `window.fetch` called unbound throws "Illegal invocation". */
const pageFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/**
 * The chat's state for the whole app: where the endpoint comes from
 * (`ChatSetup`), the conversation being shown (`ChatController`, llm-chat's
 * own) and the stored conversations. Chats are kept in IndexedDB — the same
 * `llm-chat` database and session store llm-chat's pages use, with this app's
 * own config profiles (`theia-mesh`, `theia-custom`).
 *
 * The mesh source follows `MeshService`: going live starts discovery of the
 * hub's LLM service, and a mesh call is a plain `fetch` to a URL under the
 * member's edge, which the ServiceWorker routes over the mesh.
 */
@injectable()
export class ChatService {
  @inject(MeshService) protected readonly mesh!: MeshService;

  readonly sessions: SessionStore = idbSessionStore();
  readonly setup: ChatSetup = createChatSetup({
    fetchImpl: pageFetch,
    stores: { mesh: idbConfigStore("theia-mesh"), custom: idbConfigStore("theia-custom") },
    source: {
      get: () => {
        try {
          const value = localStorage.getItem(SOURCE_KEY);
          return value === "mesh" || value === "custom" ? value : null;
        } catch {
          return null;
        }
      },
      set: (source) => {
        try {
          localStorage.setItem(SOURCE_KEY, source);
        } catch {
          // A remembered choice is a convenience only.
        }
      },
    },
  });
  readonly controller: ChatController = createChatController({
    sessions: this.sessions,
    client: endpointClient(() => this.setup.config()),
    resolveModel: (session) => resolveModel(this.setup.config(), session?.model),
    onSaved: () => void this.refreshList(),
  });

  protected list: SessionSummary[] = [];
  protected linkFor: unknown = undefined;
  protected started = false;
  protected readonly onDidChangeEmitter = new Emitter<void>();
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  @postConstruct()
  protected init(): void {
    const fire = () => this.onDidChangeEmitter.fire();
    this.setup.subscribe(fire);
    this.controller.subscribe(fire);
  }

  /** Starts following the mesh and loads the chat list; idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refreshList();
    if (this.setup.state().source === "custom") void this.setup.setSource("custom");
    this.mesh.onDidChange(() => this.followMesh());
    void this.mesh.start();
    this.followMesh();
  }

  protected followMesh(): void {
    const handle = this.mesh.handle;
    if (handle === this.linkFor) return;
    this.linkFor = handle;
    const link: MeshLink | null =
      handle == null
        ? null
        : {
            edgeBase: new URL(handle.baseUrl ?? "/peers/", location.href).href,
            hubPeerId: handle.hubPeerId,
            meshView: () => handle.meshView(),
          };
    void this.setup.meshChanged(link);
  }

  get summaries(): readonly SessionSummary[] {
    return this.list;
  }

  async refreshList(): Promise<void> {
    this.list = await this.sessions.list();
    this.onDidChangeEmitter.fire();
  }

  setSource(source: ChatSource): Promise<void> {
    return this.setup.setSource(source);
  }

  async newChat(): Promise<void> {
    await this.controller.open(null);
  }

  async deleteChat(id: string): Promise<void> {
    await this.sessions.delete(id);
    if (this.controller.getState().session?.id === id) await this.controller.open(null);
    await this.refreshList();
  }
}
