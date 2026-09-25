import type { S3ClientConfig } from "@aws-sdk/client-s3";

export function normalizeEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\/[^/]/.test(trimmed))
    throw new Error(`The endpoint must be an http:// or https:// URL, not "${trimmed}".`);
  return trimmed.replace(/\/+$/, "");
}

/** Path-style, so S3-compatible servers (RustFS, MinIO) work as AWS does. */
export function s3ClientOptions(
  config: Record<string, string>,
  secrets: { accessKeyId: string; secretAccessKey: string },
): S3ClientConfig {
  return {
    endpoint: normalizeEndpoint(config.endpoint),
    region: config.region || "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey },
  };
}
