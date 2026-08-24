/**
 * T6: the image, built and run.
 *
 * THIS SUITE BUILDS A REAL IMAGE AND STARTS A REAL CONTAINER. It is the only
 * place the Dockerfile is exercised at all, and the plan's own acceptance for
 * T6 is "build the image, run it with a fixed `RELAY_KEY`, and have a real peer
 * reserve against it" -- so the peer below is a real libp2p node dialling the
 * published port, not a fetch against `/health` standing in for one.
 *
 * IT SKIPS EXPLICITLY WHEN DOCKER IS ABSENT rather than passing quietly. A
 * container test that silently no-ops on a machine without Docker is worse than
 * no test: it reports green for the one thing nobody checked. `describe.skipIf`
 * makes vitest print the suite as skipped, and the reason is logged once.
 *
 * THE SHUTDOWN ASSERTION IS THE POINT OF THE WHOLE FILE. `docker stop` signals
 * PID 1 only. If PID 1 were a shell or a `pnpm` wrapper the signal would be
 * swallowed, the container would be SIGKILLed after the grace period, and
 * `stop()` would never run -- so the relay would drop its reservations rather
 * than release them, and the WebSocket listener and HTTP surface would die
 * mid-request. "It eventually exited" is satisfied by SIGKILL too, so that is
 * not what is asserted: the exit CODE (0, not 137) and the shutdown log line
 * are, and both within the grace period.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p, type Libp2p } from "libp2p";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { announceSubnetwork } from "../src/subnetwork.js";

const run = promisify(execFile);

/** Where the Dockerfile expects to be built from -- the umbrella root, four levels up from this app. */
const CONTEXT = new URL("../../../../../", import.meta.url).pathname;
const DOCKERFILE = "workspaces/statewalker-sandbox/apps/httpeers-relay/Dockerfile";
const IMAGE = `httpeers-relay:test-${process.pid}`;
const CONTAINER = `httpeers-relay-test-${process.pid}`;

/** The grace period `docker stop` allows before it escalates to SIGKILL. */
const STOP_GRACE_SECONDS = 10;

async function dockerAvailable(): Promise<boolean> {
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

const hasDocker = await dockerAvailable();
if (!hasDocker) {
  console.warn(
    "container.test.ts: docker is not available here, so the image is not built and none of " +
      "these assertions run. This suite is SKIPPED, not passed -- the Dockerfile is unverified " +
      "on this machine.",
  );
}

describe.skipIf(!hasDocker)("the relay container", () => {
  /** A fixed identity, so the published peerId can be checked against the key that produced it. */
  let relayKey: string;
  let expectedPeerId: string;
  let wsPort: string;
  let httpPort: string;
  const nodes: Libp2p[] = [];

  beforeAll(async () => {
    const key = await generateKeyPair("Ed25519");
    relayKey = Buffer.from(privateKeyToProtobuf(key)).toString("base64");
    expectedPeerId = peerIdFromPrivateKey(key).toString();

    await run("docker", ["build", "-f", DOCKERFILE, "-t", IMAGE, "."], {
      cwd: CONTEXT,
      maxBuffer: 64 * 1024 * 1024,
    });

    // `-p 127.0.0.1::<port>` lets the daemon pick free host ports -- the same
    // reason every other suite here binds `0` rather than a fixed number.
    await run("docker", [
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-e",
      `RELAY_KEY=${relayKey}`,
      "-p",
      "127.0.0.1::9090",
      "-p",
      "127.0.0.1::9099",
      IMAGE,
    ]);

    const port = async (container: string): Promise<string> => {
      const { stdout } = await run("docker", ["port", CONTAINER, container]);
      const mapped = stdout.split("\n")[0]?.trim().split(":").pop();
      if (mapped == null) throw new Error(`no host port published for ${container}`);
      return mapped;
    };
    wsPort = await port("9090/tcp");
    httpPort = await port("9099/tcp");

    // Wait for the relay to answer rather than sleeping -- `/health` existing
    // is exactly the signal a container platform would use.
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${httpPort}/health`)).ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error("the container never answered /health");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }, 600_000);

  afterAll(async () => {
    for (const node of nodes) await Promise.resolve(node.stop()).catch(() => {});
    await run("docker", ["rm", "-f", CONTAINER]).catch(() => {});
    await run("docker", ["rmi", "-f", IMAGE]).catch(() => {});
  }, 120_000);

  it("runs the relay as PID 1, with no shell between it and docker stop", async () => {
    const { stdout } = await run("docker", [
      "exec",
      CONTAINER,
      "sh",
      "-c",
      "tr '\\0' ' ' < /proc/1/cmdline",
    ]);
    expect(stdout.trim()).toBe("node dist/main.js");
  }, 60_000);

  it("runs as a non-root user", async () => {
    const { stdout } = await run("docker", ["exec", CONTAINER, "id", "-un"]);
    expect(stdout.trim()).toBe("node");
  }, 60_000);

  it("publishes the peerId of the key it was given, and nothing it invented", async () => {
    // THE ASSERTION THE PLAN NAMES. A relay that came up with a fresh identity
    // would start perfectly and break every client, so "the container started"
    // is not evidence and this is.
    const doc = (await (
      await fetch(`http://127.0.0.1:${httpPort}/.well-known/httpeers-relay.json`)
    ).json()) as { peerId: string; mode: string; addrs: string[] };
    expect(doc.peerId).toBe(expectedPeerId);
    expect(doc.mode).toBe("open");
    expect(doc.addrs.length).toBeGreaterThan(0);
  }, 60_000);

  it("a real peer reserves a circuit slot through it", async () => {
    // Not a fetch standing in for a peer: a libp2p node, over WebSockets, that
    // announces a subnetwork and holds a reservation the container granted.
    const node = await createLibp2p({
      privateKey: await generateKeyPair("Ed25519"),
      addresses: { listen: ["/p2p-circuit"] },
      transports: [webSockets(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
    nodes.push(node);

    const addr = `/ip4/127.0.0.1/tcp/${wsPort}/ws/p2p/${expectedPeerId}`;
    const connection = await node.dial(multiaddr(addr));
    expect(connection.remotePeer.toString()).toBe(expectedPeerId);
    await announceSubnetwork(node, connection.remotePeer, "container-test");

    const deadline = Date.now() + 30_000;
    let circuit: string | undefined;
    while (Date.now() < deadline && circuit == null) {
      circuit = node
        .getMultiaddrs()
        .map((a) => a.toString())
        .find((a) => a.includes("p2p-circuit"));
      if (circuit == null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(circuit, "no reservation was granted by the container").toBeDefined();
    expect(circuit).toContain(expectedPeerId);
  }, 120_000);

  it("ships no key material in any layer", async () => {
    // `docker export` flattens the FINAL filesystem, which for a multi-stage
    // build is exactly what ships -- the earlier stages' layers are not part of
    // this image at all. A key that reached a layer would be permanent even if
    // a later stage deleted it, which is why this checks the artifact rather
    // than reading `.dockerignore` back.
    const { stdout } = await run(
      "sh",
      [
        "-c",
        `docker create --name ${CONTAINER}-probe ${IMAGE} >/dev/null && docker export ${CONTAINER}-probe | tar -t 2>/dev/null | grep -E '\\.httpeers|\\.key$' || true`,
      ],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    await run("docker", ["rm", "-f", `${CONTAINER}-probe`]).catch(() => {});
    expect(stdout.trim()).toBe("");
  }, 300_000);

  it("ships no toolchain -- no TypeScript, no test runner, no package manager", async () => {
    const { stdout } = await run("docker", [
      "exec",
      CONTAINER,
      "sh",
      "-c",
      "ls node_modules/.bin 2>/dev/null | grep -E '^(tsc|tsx|vitest|biome)$' || true",
    ]);
    expect(stdout.trim()).toBe("");
  }, 60_000);

  it("STOPS ON SIGTERM, within the grace period, having run its shutdown", async () => {
    // The assertion this file exists for -- see the module comment. Runs last
    // because it stops the container the tests above share.
    const startedAt = Date.now();
    await run("docker", ["stop", "-t", String(STOP_GRACE_SECONDS), CONTAINER]);
    const elapsedMs = Date.now() - startedAt;

    const { stdout: code } = await run("docker", [
      "inspect",
      CONTAINER,
      "--format",
      "{{.State.ExitCode}}",
    ]);
    // 0 means the handler ran and the process chose to exit. 137 is
    // 128+SIGKILL, which is what a swallowed SIGTERM looks like -- and which
    // "it eventually exited" would not distinguish.
    expect(code.trim(), "exit code (137 means it was SIGKILLed after ignoring SIGTERM)").toBe("0");
    expect(elapsedMs).toBeLessThan(STOP_GRACE_SECONDS * 1000);

    const { stdout: logs } = await run("docker", ["logs", CONTAINER], {
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(logs).toContain("received SIGTERM, stopping");
  }, 120_000);
});
