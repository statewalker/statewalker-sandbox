# @theia-shell/theia-files-s3

The S3 mount type for [`theia-files-mounts`](../theia-files-mounts): an S3 bucket
(AWS, or any S3-compatible server) as a root folder of the app, through
`@statewalker/webrun-files-s3`. It is its own package because
`@aws-sdk/client-s3` is large: an app that does not want S3 does not depend on it.

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
