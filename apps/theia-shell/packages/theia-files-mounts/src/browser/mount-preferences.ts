import { type PreferenceSchema, PreferenceScope } from "@theia/core/lib/common/preferences";
import type { MountConfig } from "../common/mount-types";

export const MOUNTS_PREFERENCE = "files.mounts";
export const HIDDEN_PREFERENCE = "files.hidden";
export const MOUNT_SECRETS_SERVICE = "theia-shell.mounts";

/** What an app shows when the preferences are unset. */
export const MountDefaults = Symbol("MountDefaults");
export interface MountDefaults {
  mounts: MountConfig[];
  hidden: string[];
}

export const mountPreferenceSchema: PreferenceSchema = {
  properties: {
    [MOUNTS_PREFERENCE]: {
      type: "array",
      scope: PreferenceScope.User,
      description:
        "File systems mounted as root folders, besides the main storage. Secrets are kept in the vault, not here.",
      items: {
        type: "object",
        required: ["key", "name", "type", "config"],
        properties: {
          key: { type: "string", description: "The folder name at the root." },
          name: { type: "string", description: "The name shown in the explorer." },
          type: {
            type: "string",
            description: "The mount type: memory, opfs, local-folder, s3, …",
          },
          config: { type: "object", additionalProperties: { type: "string" } },
          mounted: {
            type: "boolean",
            description: "false: removed from the workspace but remembered.",
          },
        },
      },
    },
    [HIDDEN_PREFERENCE]: {
      type: "array",
      scope: PreferenceScope.User,
      items: { type: "string" },
      description:
        "Glob patterns of paths hidden everywhere: explorer, editors and search. Example: **/*.log",
    },
  },
};
