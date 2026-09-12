/**
 * 11 — Does one site behave the same over direct calls, a MessagePort, and libp2p?
 *
 * This is the ladder the requirements ask for, and its value is the DIFF: the
 * site and the scenarios cannot see which transport they are on, so any row
 * that differs is the transport's fault and nothing else.
 *
 * It also settles the directive's security claim by construction. Rungs 1 and
 * 2 contain no libp2p — the module is not even loaded in those paths — so a
 * Biscuit token verified from an `Authorization` header there is proof that
 * "the full validation works without libp2p involvement".
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { generateMeshKey, mintToken } from "@statewalker/httpeers.core/tokens";
import { peerIdOf } from "@statewalker/httpeers-stack/src/setup/keys.js";
import { createLibp2p } from "libp2p";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { directRung, libp2pRung, portRung, type Rung } from "../src/rungs.js";
import { type Outcome, runScenarios, type ScenarioInit } from "../src/scenarios.js";
import { createSite } from "../src/site.js";

describe("11 — one site, three transports", () => {
  let scenarios: ScenarioInit;
  let direct: Rung;
  let port: Rung;
  let p2p: Rung;
  let server: Awaited<ReturnType<typeof createLibp2p>>;
  let client: Awaited<ReturnType<typeof createLibp2p>>;
  const results = new Map<string, Outcome[]>();
  let provenCaller: string | undefined;

  beforeAll(async () => {
    // A real mesh key, a real token. The subject is the CLIENT's identity on
    // the libp2p rung, so the same token is usable on all three.
    const meshKey = await generateMeshKey();
    const issuer = peerIdOf(meshKey);

    server = await createLibp2p({
      addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
    client = await createLibp2p({
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
    await client.dial(server.getMultiaddrs()[0]!);

    const subject = client.peerId.toString();
    const selfPeer = server.peerId.toString();

    const goodToken = await mintToken({
      privateKey: meshKey,
      sub: subject,
      roles: ["member"],
      ttlMs: 600_000,
    });

    const foreignKey = await generateMeshKey();
    const foreignToken = await mintToken({
      privateKey: foreignKey,
      sub: subject,
      roles: ["member"],
      ttlMs: 600_000,
    });

    scenarios = { goodToken, foreignToken };

    // ONE site. The only per-rung difference is how the caller is learned:
    // claimed on rungs 1-2 (there is nothing to prove it with), proven on
    // rung 3. The site's code is identical.
    const site = createSite({ issuer, selfPeer, callerOf: () => subject });

    direct = directRung(site);
    port = await portRung(site);
    p2p = await libp2pRung(site, {
      server,
      client,
      onCaller: (peerId) => {
        provenCaller = peerId;
      },
    });

    results.set("direct", await runScenarios(direct.call, scenarios));
    results.set("port", await runScenarios(port.call, scenarios));
    results.set("libp2p", await runScenarios(p2p.call, scenarios));

    const names = results.get("direct")?.map((o) => o.name) ?? [];
    const rows = names.map((name) => {
      const cell = (rung: string) =>
        results.get(rung)?.find((o) => o.name === name)?.pass === true ? "✓" : "✗";
      return `  direct ${cell("direct")}  port ${cell("port")}  libp2p ${cell("libp2p")}  ${name}`;
    });
    console.log(`\nTransport parity:\n${rows.join("\n")}\n`);
  }, 300_000);

  afterAll(async () => {
    await p2p?.stop();
    await port?.stop();
    await direct?.stop();
    await client?.stop();
    await server?.stop();
  });

  it("CLAIM 1 — every scenario passes over DIRECT calls, with no transport at all", () => {
    const failed = (results.get("direct") ?? []).filter((o) => !o.pass);
    expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
  });

  it("CLAIM 2 — every scenario passes over a MessagePort", () => {
    const failed = (results.get("port") ?? []).filter((o) => !o.pass);
    expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
  });

  it("CLAIM 3 — every scenario passes over libp2p", () => {
    const failed = (results.get("libp2p") ?? []).filter((o) => !o.pass);
    expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
  });

  it("CLAIM 4 — the three transports agree, scenario for scenario", () => {
    const names = (results.get("direct") ?? []).map((o) => o.name);
    const disagreements = names.filter((name) => {
      const cells = ["direct", "port", "libp2p"].map(
        (rung) => results.get(rung)?.find((o) => o.name === name)?.pass,
      );
      return new Set(cells).size > 1;
    });
    expect(disagreements).toEqual([]);
  });

  it("CLAIM 5 — Biscuit validation runs with NO libp2p: rungs 1 and 2 prove it", () => {
    const name = "GET /secret with a valid token → 200 (no libp2p needed)";
    // The site verified a real token on transports that have no libp2p in the
    // call path at all. That is the directive's security requirement, met.
    expect(results.get("direct")?.find((o) => o.name === name)?.pass).toBe(true);
    expect(results.get("port")?.find((o) => o.name === name)?.pass).toBe(true);
  });

  it("CLAIM 6 — only the libp2p rung can PROVE who called; the others merely claim it", () => {
    // The asymmetry is real and must stay visible in the API: identity is a
    // proof on libp2p (Noise, per inbound stream) and a claim everywhere else.
    expect(provenCaller).toBe(client.peerId.toString());
  });
});
