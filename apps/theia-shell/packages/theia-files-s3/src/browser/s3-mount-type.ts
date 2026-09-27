import { S3Client } from "@aws-sdk/client-s3";
import type { FilesApi } from "@statewalker/webrun-files";
import { S3FilesApi } from "@statewalker/webrun-files-s3";
import { injectable } from "@theia/core/shared/inversify";
import {
  type MountConfig,
  type MountContext,
  type MountField,
  type MountType,
  SecretsLocked,
} from "@theia-shell/theia-files-mounts";
import { s3ClientOptions } from "../common/s3-options";

@injectable()
export class S3MountType implements MountType {
  readonly id = "s3";
  readonly label = "S3 Bucket";
  readonly newLabel = "New S3 Bucket…";
  readonly fields: MountField[] = [
    { name: "endpoint", label: "Endpoint URL", kind: "url", required: true },
    { name: "region", label: "Region", kind: "text", default: "us-east-1" },
    { name: "bucket", label: "Bucket", kind: "text", required: true },
    { name: "prefix", label: "Prefix (optional)", kind: "text" },
    { name: "accessKeyId", label: "Access key ID", kind: "secret", required: true },
    { name: "secretAccessKey", label: "Secret access key", kind: "secret", required: true },
  ];

  isAvailable(): boolean {
    return true;
  }

  async create(mount: MountConfig, ctx: MountContext): Promise<FilesApi> {
    const accessKeyId = await ctx.secret("accessKeyId");
    const secretAccessKey = await ctx.secret("secretAccessKey");
    if (!accessKeyId || !secretAccessKey) {
      throw ctx.locked
        ? new SecretsLocked()
        : new Error("The access keys are missing; edit the mount to enter them.");
    }
    const client = new S3Client(s3ClientOptions(mount.config, { accessKeyId, secretAccessKey }));
    const api = new S3FilesApi({
      client,
      bucket: mount.config.bucket,
      prefix: mount.config.prefix || undefined,
    });
    // Surface bad keys, a missing bucket or CORS now, as the mount's status, not on first use.
    for await (const _ of api.list("/")) break;
    return api;
  }
}
