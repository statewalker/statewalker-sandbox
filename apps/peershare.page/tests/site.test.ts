/**
 * Decision 2.8: the page is a site on httpeers' static host
 * (`peershare.httpeers.net`), with httpeers' session zone and relay.
 * `scripts/build-site.mjs` makes the folder `rclone sync` / `httpeers-publish` writes.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RELAY =
  "/dns4/relay.httpeers.net/tcp/443/wss/p2p/12D3KooWRelayRelayRelayRelayRelayRelayRelayRelay12";
let doc: { url: string; close(): Promise<void> };
const out = mkdtempSync(join(tmpdir(), "peershare-site-"));

beforeAll(async () => {
  // Stands in for https://relay.httpeers.net/.well-known/httpeers-relay.json.
  const server = createServer((_req, res) => {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ relayAddrs: [RELAY] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  doc = {
    url: `http://127.0.0.1:${address.port}/.well-known/httpeers-relay.json`,
    close: () => new Promise((r) => server.close(() => r())),
  };
  // Async: the stand-in document is served from this very process.
  await promisify(execFile)(
    "node",
    [resolve(import.meta.dirname, "../scripts/build-site.mjs"), out],
    {
      env: { ...process.env, RELAY_DOCUMENT_URL: doc.url },
    },
  );
}, 300_000);
afterAll(async () => {
  await doc?.close();
});

describe("2.8 — the site for httpeers' static host", () => {
  const site = () => join(out, "peershare.httpeers.net");

  it("is one prefix named after the domain, with the page in it", () => {
    expect(existsSync(join(site(), "index.html"))).toBe(true);
  });

  it("serves index.html for every route (/peer-share, /peer-share/invite): spa", () => {
    expect(JSON.parse(readFileSync(join(site(), ".site/config.json"), "utf8"))).toMatchObject({
      spa: true,
    });
  });

  it("names httpeers' relay (from its own document) and httpeers' session zone", () => {
    expect(JSON.parse(readFileSync(join(site(), "peershare.json"), "utf8"))).toEqual({
      relayAddrs: [RELAY],
      sessionOrigin: "https://{name}.p.httpeers.net",
    });
  });
});
