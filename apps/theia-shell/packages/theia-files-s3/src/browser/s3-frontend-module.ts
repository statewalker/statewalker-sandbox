import { ContainerModule } from "@theia/core/shared/inversify";
import { MountType } from "@theia-shell/theia-files-mounts";
import { S3MountType } from "./s3-mount-type";

export default new ContainerModule((bind) => {
  bind(S3MountType).toSelf().inSingletonScope();
  bind(MountType).toService(S3MountType);
});
