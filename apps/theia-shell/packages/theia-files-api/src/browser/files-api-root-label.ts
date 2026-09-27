import type { LabelProviderContribution } from "@theia/core/lib/browser/label-provider";
import URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileStat } from "@theia/filesystem/lib/common/files";
import { FilesApiRootLabel, FilesApiWorkspaceRoot } from "../common/files-api-source";

/** Names the FilesApi root (`file:///` by default), whose basename is empty. */
@injectable()
export class FilesApiRootLabelContribution implements LabelProviderContribution {
  @inject(FilesApiWorkspaceRoot) protected readonly root!: FilesApiWorkspaceRoot;
  @inject(FilesApiRootLabel) protected readonly label!: FilesApiRootLabel;

  canHandle(element: object): number {
    return this.isRoot(element) ? 100 : 0;
  }

  getName(): string {
    return this.label;
  }

  private isRoot(element: object): boolean {
    const uri =
      element instanceof URI ? element : FileStat.is(element) ? element.resource : undefined;
    return (
      !!uri && uri.withoutQuery().withoutFragment().toString() === new URI(this.root).toString()
    );
  }
}
