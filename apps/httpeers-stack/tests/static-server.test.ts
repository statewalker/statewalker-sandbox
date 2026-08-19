/**
 * Task 9, Step 3: the static server, exercised over real bound ports (no
 * mocking `node:http`) -- `pnpm vitest run --no-file-parallelism` because
 * these tests bind real sockets. Every server here binds port `0`
 * (ephemeral) rather than the fixed production ports (5175/5176), so this
 * suite never depends on those ports being free.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOriginServer,
  type OriginServer,
  startStaticServer,
} from "../src/static-server/main.js";

/**
 * A raw request with a literal `..` path segment, bypassing `fetch`/`URL`'s
 * own dot-segment normalization (which would otherwise collapse `..` before
 * the request ever left the client, defeating the point of this test) --
 * `node:http`'s client sends `path` on the wire unmodified.
 */
function rawGet(port: number, rawPath: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolvePromise(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "httpeers-static-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writePage(distDir: string, opts: { title: string; swFile?: string }): void {
  writeFileSync(join(distDir, "index.html"), `<!doctype html><title>${opts.title}</title>`);
  writeFileSync(join(distDir, opts.swFile ?? "sw.js"), `// service worker for ${opts.title}\n`);
}

describe("static-server: both origins", () => {
  let servers: Awaited<ReturnType<typeof startStaticServer>>;
  let appDistDir: string;
  let imagePeerDistDir: string;
  let configPath: string;

  beforeEach(async () => {
    appDistDir = join(workDir, "app");
    imagePeerDistDir = join(workDir, "image-peer");
    mkdirSync(appDistDir, { recursive: true });
    mkdirSync(imagePeerDistDir, { recursive: true });
    writePage(appDistDir, { title: "main app" });
    writePage(imagePeerDistDir, { title: "image peer" });

    configPath = join(workDir, "httpeers.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        relayAddrs: ["/ip4/127.0.0.1/tcp/9090/ws/p2p/12D3fake"],
        hubPeerId: "12D3fakehub",
      }),
    );

    servers = await startStaticServer({
      appDistDir,
      imagePeerDistDir,
      httpeersConfigPath: configPath,
      appPort: 0,
      imagePeerPort: 0,
    });
  });

  afterEach(async () => {
    await servers.stop();
  });

  it("serves the app origin's index.html", async () => {
    const res = await fetch(`http://127.0.0.1:${servers.appPort}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("main app");
  });

  it("serves the image-peer origin's index.html, distinct from the app's", async () => {
    const res = await fetch(`http://127.0.0.1:${servers.imagePeerPort}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("image peer");
  });

  it("serves each origin's ServiceWorker script with the right content type and no-cache headers", async () => {
    for (const port of [servers.appPort, servers.imagePeerPort]) {
      const res = await fetch(`http://127.0.0.1:${port}/sw.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/javascript");
      expect(res.headers.get("cache-control")).toMatch(/no-cache|no-store/);
      expect(res.headers.get("service-worker-allowed")).toBe("/");
    }
  });

  it("serves /httpeers.json identically at both origins when present", async () => {
    for (const port of [servers.appPort, servers.imagePeerPort]) {
      const res = await fetch(`http://127.0.0.1:${port}/httpeers.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json();
      expect(body.hubPeerId).toBe("12D3fakehub");
    }
  });

  it("returns 404, not 500, for an unknown GET path", async () => {
    const res = await fetch(`http://127.0.0.1:${servers.appPort}/does/not/exist`);
    expect(res.status).toBe(404);
  });

  it("returns 404, not 500, for a POST to an unknown path -- the duplex/passthrough regression case", async () => {
    // A published version of a package in this workspace had a passthrough
    // branch that rebuilt the Request without `duplex: "half"`, turning
    // every unmatched POST into a 500. This is that regression, asserted
    // directly against this server rather than trusted to the GET case above.
    const res = await fetch(`http://127.0.0.1:${servers.appPort}/does/not/exist`, {
      method: "POST",
      body: JSON.stringify({ probe: true }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("never resolves a '..'-shaped path to a file outside its distDir -- not a 500, and not a leaked file", async () => {
    // Sent raw (bypassing `fetch`/`URL`'s own client-side normalization,
    // which would otherwise rewrite ".." away before the request left the
    // client) so this exercises the server's own handling of the literal
    // bytes on the wire, whatever combination of `new URL()`'s path
    // shortening and `resolveDistFile`'s explicit root check is doing the
    // work.
    const status = await rawGet(servers.imagePeerPort, "/../app/index.html");
    expect(status).toBe(404);
  });
});

describe("static-server: /httpeers.json absent", () => {
  let server: OriginServer;
  let port: number;
  let distDir: string;

  beforeEach(async () => {
    distDir = join(workDir, "app");
    mkdirSync(distDir, { recursive: true });
    writePage(distDir, { title: "main app" });

    server = createOriginServer({
      port: 0,
      distDir,
      httpeersConfigPath: join(workDir, "httpeers.json"), // deliberately never written
    });
    port = await server.listen();
  });

  afterEach(async () => {
    await server.close();
  });

  it("gives a clear 503, not a 404, when httpeers.json has not been generated yet", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/httpeers.json`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/setup/i);
  });

  it("still serves index.html and 404s an unknown path normally", async () => {
    const okRes = await fetch(`http://127.0.0.1:${port}/`);
    expect(okRes.status).toBe(200);

    const missingRes = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(missingRes.status).toBe(404);
  });
});
