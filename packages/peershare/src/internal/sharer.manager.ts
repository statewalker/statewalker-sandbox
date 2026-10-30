/**
 * The Sharer's Services: the one place they change. Commands call it; the
 * mesh reads it through `mount()`; the store keeps it across reloads.
 */

import { probe, type ServiceEntry, serviceTable } from "@statewalker/httpeers-share";
import type { Upstream } from "@statewalker/webrun-http-proxy";
import type { UpstreamKind } from "../public/extension-points.js";
import type {
  Result,
  ServiceDraft,
  SharedService,
  SharerState,
  SharerStore,
} from "../public/types.js";

export class SharerManager {
  private state: SharerState = { name: "", services: [] };
  private readonly upstreams = new Map<string, Upstream>();
  /** Every operation waits for the stored state: nothing acts on an empty Sharer during a reload. */
  readonly ready: Promise<void>;

  constructor(
    private readonly store: SharerStore,
    private readonly kinds: () => ReadonlyMap<string, UpstreamKind>,
  ) {
    this.ready = store.load().then((saved) => {
      if (saved != null) this.state = saved;
    });
  }

  /** "Test again": one request through the Upstream Guests use (httpeers-share `probe`). */
  async probe(id: string): Promise<void> {
    const service = this.state.services.find((s) => s.id === id);
    if (service == null) return;
    if (!service.enabled)
      return this.update(id, { health: "disabled", cause: undefined, warnings: [] });
    await this.update(id, { health: "checking" });
    const direct = service.kind === "direct" ? { direct: service.target } : {};
    const report = await probe(this.upstreamOf(service), direct);
    await this.update(id, {
      health: report.health,
      cause: report.cause,
      warnings: report.warnings,
    });
  }

  private async update(id: string, patch: Partial<SharedService>): Promise<void> {
    this.state.services = this.state.services.map((s) => (s.id === id ? { ...s, ...patch } : s));
    await this.save();
  }

  snapshot(): SharerState {
    return structuredClone(this.state);
  }

  async add(draft: ServiceDraft): Promise<Result<{ id: string }>> {
    const refused = this.check(draft);
    if (refused != null) return refused;
    const id = uniqueId(draft.name, this.state.services);
    const isDefault = draft.isDefault ?? this.state.services.length === 0;
    this.state.services = [
      ...this.state.services.map((s) => (isDefault ? { ...s, isDefault: false } : s)),
      { id, name: draft.name, kind: draft.kind, target: draft.target, enabled: true, isDefault },
    ];
    await this.save();
    return { ok: true, id };
  }

  async edit(id: string, draft: ServiceDraft): Promise<Result> {
    const refused = this.check(draft);
    if (refused != null) return refused;
    if (!this.state.services.some((s) => s.id === id))
      return { ok: false, reason: "unknown-service" };
    this.state.services = this.state.services.map((s) =>
      // Health belongs to the old target: dropped until the next Probe.
      s.id === id
        ? {
            id,
            name: draft.name,
            kind: draft.kind,
            target: draft.target,
            enabled: s.enabled,
            isDefault: s.isDefault,
          }
        : s,
    );
    await this.save();
    return { ok: true };
  }

  async remove(id: string): Promise<void> {
    const removed = this.state.services.find((s) => s.id === id);
    const rest = this.state.services.filter((s) => s.id !== id);
    // There is always a Default while there is anything at all.
    if (removed?.isDefault === true && rest[0] != null) rest[0] = { ...rest[0], isDefault: true };
    this.state.services = rest;
    await this.save();
  }

  async setDefault(id: string): Promise<void> {
    if (!this.state.services.some((s) => s.id === id)) return;
    this.state.services = this.state.services.map((s) => ({ ...s, isDefault: s.id === id }));
    await this.save();
  }

  async toggle(id: string, enabled: boolean): Promise<void> {
    this.state.services = this.state.services.map((s) => (s.id === id ? { ...s, enabled } : s));
    await this.save();
  }

  async setName(name: string): Promise<void> {
    this.state.name = name;
    await this.save();
  }

  /** The Sharer's `/s` mount: what Guests reach over the mesh. */
  mount() {
    return serviceTable(() => this.entries(), { sharerName: () => this.state.name });
  }

  private entries(): ServiceEntry[] {
    return this.state.services.map((s) => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      isDefault: s.isDefault,
      upstream: this.upstreamOf(s),
    }));
  }

  private upstreamOf(service: SharedService): Upstream {
    const key = `${service.kind} ${service.target}`;
    let upstream = this.upstreams.get(key);
    if (upstream == null) {
      const kind = this.kinds().get(service.kind);
      upstream =
        kind?.create(service.target) ?? (async () => new Response("unknown kind", { status: 502 }));
      this.upstreams.set(key, upstream);
    }
    return upstream;
  }

  private check(draft: ServiceDraft): { ok: false; reason: string } | undefined {
    if (draft.name.trim() === "") return { ok: false, reason: "needs-name" };
    const kind = this.kinds().get(draft.kind);
    if (kind == null) return { ok: false, reason: "unknown-kind" };
    const check = kind.check(draft.target);
    return check.ok ? undefined : { ok: false, reason: check.reason };
  }

  private save(): Promise<void> {
    return this.store.save(this.snapshot());
  }
}

function uniqueId(name: string, services: readonly SharedService[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "service";
  let id = base;
  for (let n = 2; services.some((s) => s.id === id); n++) id = `${base}-${n}`;
  return id;
}
