// An S3-compatible server for tests: RustFS in Docker, with one bucket whose
// CORS rule lets the app (a browser page on `origin`) sign requests to it.
import { execFileSync } from "node:child_process";
import { CreateBucketCommand, PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";

export const RUSTFS_IMAGE = "rustfs/rustfs:1.0.0-beta.8";

/** Headers the AWS SDK sends from a browser. Listed, not "*": a wildcard never covers Authorization. */
export const S3_BROWSER_HEADERS = [
  "authorization",
  "content-type",
  "content-length",
  "content-md5",
  "x-amz-date",
  "x-amz-content-sha256",
  "x-amz-user-agent",
  "x-amz-checksum-crc32",
  "x-amz-checksum-mode",
  "x-amz-sdk-checksum-algorithm",
  "amz-sdk-invocation-id",
  "amz-sdk-request",
];

export function hasDocker() {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ port: number, origin: string, bucket?: string }} options
 */
export async function startRustFs({ port, origin, bucket = "theia-shell" }) {
  const name = `theia-shell-rustfs-${port}`;
  const accessKeyId = "theiashell";
  const secretAccessKey = "theiashell-secret";
  execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      name,
      "-p",
      `127.0.0.1:${port}:9000`,
      "-e",
      `RUSTFS_ACCESS_KEY=${accessKeyId}`,
      "-e",
      `RUSTFS_SECRET_KEY=${secretAccessKey}`,
      RUSTFS_IMAGE,
    ],
    { stdio: "ignore" },
  );
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  await retry(() => client.send(new CreateBucketCommand({ Bucket: bucket })));
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [origin],
            AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
            AllowedHeaders: S3_BROWSER_HEADERS,
            ExposeHeaders: ["ETag", "x-amz-version-id"],
            MaxAgeSeconds: 600,
          },
        ],
      },
    }),
  );
  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    client,
    stop() {
      client.destroy();
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    },
  };
}

async function retry(fn, attempts = 40) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw last;
}
