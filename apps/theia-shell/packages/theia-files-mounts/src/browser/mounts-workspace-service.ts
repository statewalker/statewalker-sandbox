import { inject, injectable } from "@theia/core/shared/inversify";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import { WORKSPACE_FILE_URI } from "../common/workspace-file";

/**
 * Starts the mounts (and so writes the workspace file). A function resolved
 * lazily: MountService depends, through the preferences, on WorkspaceService.
 */
export const StartMounts = Symbol("StartMounts");
export type StartMounts = () => Promise<unknown>;

/**
 * Always opens the mounts workspace, whose folders are the mounts. Theia reads
 * the default workspace from the URL fragment as a `file:` path and writes it
 * back there; the mounts workspace lives under `shell-system:`, so both are
 * bypassed. The mounts are started first, so the file exists.
 */
@injectable()
export class MountsWorkspaceService extends WorkspaceService {
  @inject(StartMounts) protected readonly startMounts!: StartMounts;

  protected override async getDefaultWorkspaceUri(): Promise<string | undefined> {
    await this.startMounts();
    return WORKSPACE_FILE_URI;
  }

  protected override setURLFragment(): void {}
}
