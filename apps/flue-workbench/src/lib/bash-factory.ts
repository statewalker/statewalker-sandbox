import type { BashFactory, BashLike } from "@flue/runtime";
import type { FilesApi } from "@statewalker/webrun-files";
import { Bash, type BashOptions, type CustomCommand } from "just-bash";
import { FilesApiAdapter } from "./files-api-adapter.js";

export interface FilesApiBashFactoryOptions {
  files: FilesApi;
  cwd?: string;
  env?: Record<string, string>;
  customCommands?: CustomCommand[];
  javascript?: BashOptions["javascript"];
  network?: BashOptions["network"];
}

/**
 * Build a Flue `BashFactory` that constructs a `Bash` instance over a
 * `FilesApiAdapter` wrapping the supplied `FilesApi`. The factory is
 * stateful: each call creates a new `Bash` against a new `FilesApiAdapter`
 * — but the adapter delegates to the same `FilesApi`, so multiple bashes
 * spawned from the same factory share filesystem state (this is what the
 * "two-bash one-FS" contract relies on at the workbench layer).
 */
export function filesApiBashFactory(opts: FilesApiBashFactoryOptions): BashFactory {
  return () => {
    const fs = new FilesApiAdapter({ files: opts.files, cwd: opts.cwd ?? "/" });
    const bash = new Bash({
      fs,
      cwd: opts.cwd ?? "/",
      env: opts.env ?? {},
      customCommands: opts.customCommands ?? [],
      ...(opts.javascript !== undefined ? { javascript: opts.javascript } : {}),
      ...(opts.network !== undefined ? { network: opts.network } : {}),
    });
    // `Bash` is structurally a superset of `BashLike` — Flue only relies on
    // `exec`, `getCwd`, and the `fs` subset, all of which `Bash` provides.
    return bash as unknown as BashLike;
  };
}
