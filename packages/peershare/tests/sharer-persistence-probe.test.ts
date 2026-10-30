/** M1 — the Sharer survives a reload, and "Test again" probes through the Upstream Guests use. */

import { createServer } from "node:http";
import { createBridge, type Listening, listenLoopback } from "@statewalker/httpeers-share/bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AddService, GetSharer, ProbeService, ToggleService } from "../src/public/commands.js";
import { memoryStore, withPeerShare } from "./harness.js";

describe("M1 — reload", () => {
  it("a new runtime over the same store has the same Sharer, and new ids stay unique", async () => {
    const store = memoryStore();
    const first = withPeerShare({ store });
    await first.call(AddService, { name: "foo", kind: "bridged", target: "http://localhost:5173" });
    first.dispose();

    const again = withPeerShare({ store });
    expect((await again.call(GetSharer, undefined)).services.map((s) => s.id)).toEqual(["foo"]);
    expect(
      await again.call(AddService, {
        name: "foo",
        kind: "bridged",
        target: "http://localhost:3000",
      }),
    ).toEqual({
      ok: true,
      id: "foo-2",
    });
  });
});

const TOKEN = "peershare-m1";
let bridge: Listening;
let app: { origin: string; close(): Promise<void> };

beforeAll(async () => {
  bridge = await listenLoopback(
    createBridge({ token: TOKEN, allowedOrigin: "https://tools.sandclaw.ai" }),
  );
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "s=1" });
    res.end('<script type="module" src="/@vite/client"></script>');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  app = {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
});
afterAll(async () => {
  await bridge?.close();
  await app?.close();
});

describe("M1 — Test again", () => {
  it("records Health and warnings on the Service", async () => {
    const { call } = withPeerShare({ bridge: () => ({ base: bridge.origin, token: TOKEN }) });
    await call(AddService, { name: "dev", kind: "bridged", target: app.origin });

    await call(ProbeService, { id: "dev" });

    expect((await call(GetSharer, undefined)).services[0]).toMatchObject({
      health: "ok",
      warnings: ["ws-needed", "cookies-set"],
    });
  });

  it("down, cause bridge-down, before the Bridge is paired; disabled when paused", async () => {
    const { call } = withPeerShare();
    await call(AddService, { name: "dev", kind: "bridged", target: app.origin });

    await call(ProbeService, { id: "dev" });
    expect((await call(GetSharer, undefined)).services[0]).toMatchObject({
      health: "down",
      cause: "bridge-down",
    });

    await call(ToggleService, { id: "dev", enabled: false });
    await call(ProbeService, { id: "dev" });
    expect((await call(GetSharer, undefined)).services[0]).toMatchObject({ health: "disabled" });
  });
});
