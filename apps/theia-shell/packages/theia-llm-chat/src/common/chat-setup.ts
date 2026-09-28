/**
 * Where the chat's endpoint comes from, and the steps to a usable one.
 *
 * Two sources, each with its own stored config (so switching back and forth
 * keeps both):
 *
 * - `mesh`: the LLM service of the mesh this browser has joined. Discovery is
 *   llm-chat's `mesh.html` flow, verbatim in its rules: only the HUB's own
 *   `llm` advert counts, the hub's OpenAPI document names the service base,
 *   the key header and whether keys can be requested, and every URL it yields
 *   must stay under `<edge><hub>/llm/` (`discoverLlm` enforces that). The
 *   service needs a key of its own: pasted, or requested by an admin.
 * - `custom`: any OpenAI-compatible endpoint, as llm-chat's standalone page.
 *
 * Either way the models are listed with the key before the chat opens, so a
 * wrong key is reported on the step that asked for it.
 *
 * No DOM and no Theia: the browser side feeds it the member's state and
 * renders `state()`.
 */

import { applyEndpoint, type ChatConfig, type ConfigStore, refreshModels } from "./core/config.js";
import { describeError, listModels } from "./core/openai-client.js";
import {
  discoverLlm,
  findLlmAdvert,
  isMeshAdmin,
  type LlmService,
  type MeshViewLike,
  meshConfig,
  mintKey,
} from "./mesh/discover.js";

export type ChatSource = "mesh" | "custom";

/** What the chat needs from a live mesh member. */
export interface MeshLink {
  /** `<origin>/peers/`. */
  edgeBase: string;
  hubPeerId: string;
  meshView(): MeshViewLike | null;
}

export type SetupStage =
  /** Mesh source, but this browser is not live on a mesh. */
  | { kind: "mesh-offline" }
  | { kind: "finding" }
  | { kind: "unavailable"; message: string }
  /** The mesh service needs a key: paste one, or (`canRequest`) request one. */
  | { kind: "key"; canRequest: boolean; admin: boolean; error?: string }
  /** The custom endpoint: base URL and key. */
  | { kind: "endpoint"; baseUrl: string; error?: string }
  | { kind: "loading-models" }
  | {
      kind: "ready";
      config: ChatConfig;
      dashboardUrl?: string;
      canRequest: boolean;
      admin: boolean;
    };

export interface SetupState {
  source: ChatSource;
  stage: SetupStage;
}

export interface ChatSetupInit {
  fetchImpl: typeof fetch;
  stores: Record<ChatSource, ConfigStore>;
  /** The remembered source choice; `null` means never chosen (the mesh). */
  source: { get(): ChatSource | null; set(source: ChatSource): void };
  /** How long to wait for the hub's `llm` advert, which arrives on a heartbeat. */
  advertWaitMs?: number;
}

export interface ChatSetup {
  state(): SetupState;
  subscribe(listener: () => void): () => void;
  /** The config the chat runs on, once the stage is `ready`. */
  config(): ChatConfig | null;
  setSource(source: ChatSource): Promise<void>;
  /** The member went live, changed, or stopped (`null`). */
  meshChanged(link: MeshLink | null): Promise<void>;
  /** Discover the mesh service again (after `unavailable`). */
  retry(): Promise<void>;
  submitKey(key: string): Promise<void>;
  requestKey(): Promise<void>;
  submitEndpoint(endpoint: { baseUrl: string; apiKey: string }): Promise<void>;
  /** Back to the key or endpoint step, to change it. */
  reconfigure(): void;
  chooseModel(model: string): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createChatSetup(init: ChatSetupInit): ChatSetup {
  let source: ChatSource = init.source.get() ?? "mesh";
  let stage: SetupStage =
    source === "mesh" ? { kind: "mesh-offline" } : { kind: "endpoint", baseUrl: "" };
  let link: MeshLink | null = null;
  let service: LlmService | null = null;
  let current: ChatConfig | null = null;
  /** Bumped by anything that makes an in-flight step stale. */
  let run = 0;
  const listeners = new Set<() => void>();

  const set = (next: SetupStage) => {
    stage = next;
    for (const listener of listeners) listener();
  };
  const admin = () => isMeshAdmin(link?.meshView() ?? null);
  const message = (error: unknown) => {
    const notice = describeError(error);
    return notice.hint == null ? notice.message : `${notice.message} ${notice.hint}`;
  };
  const keyStage = (error?: string): SetupStage => ({
    kind: "key",
    canRequest: service?.canMintKeys ?? false,
    admin: admin(),
    ...(error == null ? {} : { error }),
  });

  /** List the models with `config`'s key; `ready` on success, else back to `fallback` with the reason. */
  async function openWith(
    config: ChatConfig,
    mine: number,
    fallback: (error: string) => SetupStage,
  ): Promise<void> {
    set({ kind: "loading-models" });
    try {
      const fetched = await listModels(config, { fetchImpl: init.fetchImpl });
      if (mine !== run) return;
      if (fetched.length === 0 && config.models.length === 0) {
        set(fallback("The endpoint lists no models."));
        return;
      }
      const next = refreshModels(config, fetched);
      await init.stores[source].set(next);
      if (mine !== run) return;
      current = next;
      set({
        kind: "ready",
        config: next,
        ...(service != null && source === "mesh" ? { dashboardUrl: service.dashboardUrl } : {}),
        canRequest: source === "mesh" && (service?.canMintKeys ?? false),
        admin: source === "mesh" && admin(),
      });
    } catch (error) {
      if (mine === run) set(fallback(message(error)));
    }
  }

  async function discover(): Promise<void> {
    const mine = ++run;
    current = null;
    service = null;
    if (source !== "mesh") return;
    const live = link;
    if (live == null) {
      set({ kind: "mesh-offline" });
      return;
    }
    set({ kind: "finding" });
    let advert = findLlmAdvert(live.meshView(), live.hubPeerId);
    for (let waited = 0; advert == null && waited < (init.advertWaitMs ?? 30_000); waited += 500) {
      await sleep(500);
      if (mine !== run) return;
      advert = findLlmAdvert(live.meshView(), live.hubPeerId);
    }
    if (mine !== run) return;
    if (advert == null) {
      set({ kind: "unavailable", message: "This mesh's hub advertises no LLM service." });
      return;
    }
    try {
      service = await discoverLlm(init.fetchImpl, live.edgeBase, live.hubPeerId);
      if (mine !== run) return;
      const config = meshConfig(await init.stores.mesh.get(), service);
      await init.stores.mesh.set(config);
      if (mine !== run) return;
      if (config.apiKey == null || config.apiKey === "") set(keyStage());
      else await openWith(config, mine, (error) => keyStage(error));
    } catch (error) {
      if (mine === run) set({ kind: "unavailable", message: message(error) });
    }
  }

  async function startCustom(): Promise<void> {
    const mine = ++run;
    current = null;
    const stored = await init.stores.custom.get();
    if (mine !== run) return;
    if (stored == null || stored.baseUrl === "") {
      set({ kind: "endpoint", baseUrl: "" });
      return;
    }
    await openWith(stored, mine, (error) => ({ kind: "endpoint", baseUrl: stored.baseUrl, error }));
  }

  return {
    state: () => ({ source, stage }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    config: () => current,
    async setSource(next) {
      source = next;
      init.source.set(next);
      if (next === "mesh") await discover();
      else await startCustom();
    },
    async meshChanged(next) {
      const same =
        link != null &&
        next != null &&
        link.edgeBase === next.edgeBase &&
        link.hubPeerId === next.hubPeerId;
      link = next;
      if (source !== "mesh" || (same && stage.kind !== "mesh-offline")) return;
      await discover();
    },
    retry: () => (source === "mesh" ? discover() : startCustom()),
    async submitKey(key) {
      if (service == null || key.trim() === "") return;
      const mine = ++run;
      const config = { ...meshConfig(await init.stores.mesh.get(), service), apiKey: key.trim() };
      await openWith(config, mine, (error) => keyStage(error));
    },
    async requestKey() {
      if (service == null) return;
      const mine = ++run;
      try {
        const key = await mintKey(init.fetchImpl, service.serviceBase);
        if (mine !== run) return;
        const config = { ...meshConfig(await init.stores.mesh.get(), service), apiKey: key };
        await openWith(config, mine, (error) => keyStage(error));
      } catch (error) {
        if (mine === run) set(keyStage(message(error)));
      }
    },
    async submitEndpoint(endpoint) {
      const mine = ++run;
      const config = applyEndpoint(await init.stores.custom.get(), endpoint);
      await openWith(config, mine, (error) => ({
        kind: "endpoint",
        baseUrl: config.baseUrl,
        error,
      }));
    },
    reconfigure() {
      ++run;
      current = null;
      if (source === "mesh") set(service == null ? { kind: "mesh-offline" } : keyStage());
      else set({ kind: "endpoint", baseUrl: stage.kind === "ready" ? stage.config.baseUrl : "" });
    },
    async chooseModel(model) {
      if (current == null || !current.models.includes(model)) return;
      current = { ...current, defaultModel: model };
      await init.stores[source].set(current);
      if (stage.kind === "ready") set({ ...stage, config: current });
    },
  };
}
