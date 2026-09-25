import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { injectable } from "@theia/core/shared/inversify";
import type { MountField, MountType } from "../../common/mount-types";

@injectable()
export class MemoryMountType implements MountType {
  readonly id = "memory";
  readonly label = "In Memory (lost on reload)";
  readonly fields: MountField[] = [];

  isAvailable(): boolean {
    return true;
  }

  async create(): Promise<FilesApi> {
    return new MemFilesApi();
  }
}
