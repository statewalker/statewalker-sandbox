import { inject, injectable } from "@theia/core/shared/inversify";
import { BrowserOnlyWorkspaceServer } from "@theia/workspace/lib/browser-only/browser-only-workspace-server";
import { FilesApiWorkspaceRoot } from "../common/files-api-source";

/**
 * The browser-only workspace server remembers recent workspaces in
 * localStorage. On a first visit there is none, and the explorer would show
 * "no folder opened"; this opens the FilesApi root instead.
 */
@injectable()
export class FilesApiWorkspaceServer extends BrowserOnlyWorkspaceServer {
  @inject(FilesApiWorkspaceRoot)
  protected readonly defaultRoot!: FilesApiWorkspaceRoot;

  override async getMostRecentlyUsedWorkspace(): Promise<string | undefined> {
    return (await super.getMostRecentlyUsedWorkspace()) ?? this.defaultRoot;
  }
}
