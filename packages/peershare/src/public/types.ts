/** PeerShare's domain, as views and other Features see it (GLOSSARY.md). */

import type { Health, ProbeCause, ProbeWarning } from "@statewalker/httpeers-share";

export interface ServiceDraft {
  name: string;
  /** An id of the `peershare:upstream-kinds` extension point: "bridged", "direct", or another Feature's. */
  kind: string;
  target: string;
  isDefault?: boolean;
}

export interface SharedService {
  id: string;
  name: string;
  kind: string;
  target: string;
  enabled: boolean;
  isDefault: boolean;
  /** The last Probe, or `checking` while one runs. */
  health?: Health | "checking" | "disabled";
  cause?: ProbeCause;
  warnings?: ProbeWarning[];
}

export interface SharerState {
  name: string;
  services: SharedService[];
}

export type Refusal = { ok: false; reason: string };
export type Result<T extends object = object> = ({ ok: true } & T) | Refusal;

/** Where the Sharer's state survives a reload (IndexedDB in the page, memory in tests). */
export interface SharerStore {
  load(): Promise<SharerState | undefined>;
  save(state: SharerState): Promise<void>;
}
