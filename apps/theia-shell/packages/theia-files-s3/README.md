# @theia-shell/theia-files-s3

The S3 mount type for [`theia-files-mounts`](../theia-files-mounts): an S3 bucket
(AWS, or any S3-compatible server) as a root folder of the app, through
`@statewalker/webrun-files-s3`. It is its own package because
`@aws-sdk/client-s3` is large: an app that does not want S3 does not depend on it.

## The mount type

Fields: endpoint URL (http/https; a trailing slash is dropped), region (default
`us-east-1`), bucket, prefix, and two secrets — access key ID and secret access
key — which go to the vault, never to `settings.json`. Path-style addressing, so
S3-compatible servers (RustFS, MinIO) work as AWS does. Mounting lists the bucket
once, so bad keys, a missing bucket or a CORS refusal show as the mount's status
("Cloud (unavailable: …)") instead of on first use; with the vault locked it is
"Cloud (locked)" until *Secrets: Unlock*.

**CORS.** A browser only reaches a bucket whose CORS rule allows the app's origin
and every header the SDK sends. `S3_BROWSER_HEADERS` in
[`tools/rustfs.mjs`](../../tools/rustfs.mjs) is the list that works (it includes
`x-amz-checksum-mode`, which reads send); use it for real buckets too.

## Tests

`pnpm test` runs the unit tests. The S3 end-to-end tests (in
[`app/tests/s3.spec.ts`](../../app/tests/s3.spec.ts)) and one unit test here
run against **RustFS** in Docker, started by [`tools/rustfs.mjs`](../../tools/rustfs.mjs);
they are skipped when Docker is not available.

A browser can only reach a bucket whose CORS rule allows the app's origin.
The fixture sets one with `PutBucketCors`. RustFS echoes `AllowedHeaders`
literally, and a `*` never covers `Authorization` (Fetch spec), which every
signed S3 request sends, so the rule lists the SDK's headers explicitly
(`S3_BROWSER_HEADERS`).

## Red / green

- **RustFS fixture.** Red: 1 of 1 against a stub (`not implemented`). Green: 1 of 1 —
  the preflight from `http://127.0.0.1:3100` allows the origin and each signed header.
- **`s3ClientOptions` / `normalizeEndpoint`** (`tests/s3-options.test.ts`). Red: the
  module missing. Green: 3 of 3; the package's 4 of 4.
- **End to end** (`app/tests/s3.spec.ts`). Red: 4 of 4 (no "S3 Bucket" type before
  the module joined the app). Then 2 of 4: the first read failed CORS because the
  SDK's `x-amz-checksum-mode` header was not in the fixture's list (added), and a
  reload right after mounting could come before Theia wrote `settings.json` (the
  tests now wait for it). Green: 4 of 4, twice in a row.
