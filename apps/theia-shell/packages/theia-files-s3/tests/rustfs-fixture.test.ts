import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module shared with the Playwright tests
import { hasDocker, startRustFs } from "../../../tools/rustfs.mjs";

const ORIGIN = "http://127.0.0.1:3100";
const itDocker = hasDocker() ? it : it.skip;

describe("RustFS fixture", () => {
  itDocker("allows a signed browser request from the test origin", async () => {
    const s3 = await startRustFs({ port: 19100, origin: ORIGIN });
    try {
      const res = await fetch(`${s3.endpoint}/${s3.bucket}/probe.txt`, {
        method: "OPTIONS",
        headers: {
          Origin: ORIGIN,
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers":
            "authorization,x-amz-date,x-amz-content-sha256,amz-sdk-invocation-id",
        },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      const allowed = (res.headers.get("access-control-allow-headers") ?? "")
        .toLowerCase()
        .split(/\s*,\s*/);
      // A "*" would not do: it never covers Authorization (Fetch spec).
      for (const header of [
        "authorization",
        "x-amz-date",
        "x-amz-content-sha256",
        "amz-sdk-invocation-id",
      ]) {
        expect(allowed).toContain(header);
      }
    } finally {
      s3.stop();
    }
  });
});
