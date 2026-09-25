import type { FilesApi } from "@statewalker/webrun-files";

export interface MountField {
  name: string;
  label: string;
  kind: "text" | "secret" | "url";
  required?: boolean;
  default?: string | ((mount: { key: string; name: string }) => string);
}

/** One entry of the `files.mounts` preference. `config` never holds secrets. */
export interface MountConfig {
  key: string;
  name: string;
  type: string;
  config: Record<string, string>;
}

export interface MountContext {
  /** True when running from a user gesture (wizard, Reconnect). */
  interactive: boolean;
  /** True while the vault is locked: a missing secret then means "locked", not "missing". */
  locked: boolean;
  /** A `secret` field's value from the vault; undefined when locked or absent. */
  secret(field: string): Promise<string | undefined>;
}

/** A kind of file system users can mount. Bind with `bind(MountType).to…`. */
export const MountType = Symbol("MountType");
export interface MountType {
  readonly id: string;
  readonly label: string;
  readonly fields: MountField[];
  isAvailable(): boolean;
  create(mount: MountConfig, ctx: MountContext): Promise<FilesApi>;
  /** An interactive step after the fields (e.g. a folder picker); returns config to merge, or undefined to cancel. */
  configure?(mount: MountConfig): Promise<Record<string, string> | undefined>;
  /** Cleans up what the type stored outside `config` when the mount is removed. */
  forget?(mount: MountConfig): Promise<void>;
}

/** Thrown by `create` when it can only proceed from a user gesture. */
export class NeedsUserGesture extends Error {
  constructor() {
    super("Needs a click to get access");
    this.name = "NeedsUserGesture";
  }
}

/** Thrown by `create` when a required secret is unavailable because the vault is locked (`ctx.locked`). */
export class SecretsLocked extends Error {
  constructor() {
    super("Secrets are locked");
    this.name = "SecretsLocked";
  }
}

export type MountStatus =
  | { state: "mounted" }
  | { state: "needs-access" }
  | { state: "locked" }
  | { state: "failed"; message: string };
