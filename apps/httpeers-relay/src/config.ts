/**
 * The relay's whole configuration surface, and it is the environment.
 *
 * CONFIGURATION IS ENVIRONMENT ONLY -- there is no config file, and there is
 * deliberately no code path that exists solely for our own deployment. The
 * relay running at a public name must be the same artifact a self-hoster
 * pulls, because self-hosting is the commercial position and a
 * half-maintained self-host path poisons it. So every knob below is an
 * environment variable with a documented default, and a deployment differs
 * from a laptop only in what it sets.
 *
 * THIS MODULE THROWS, IT DOES NOT EXIT. Every failure here is a
 * `RelayConfigError` carrying operator-facing guidance; `main.ts` catches it,
 * prints it, and exits 1. That split is not cosmetic: the previous version of
 * this loader called `process.exit(1)` from library code, so its error paths
 * -- the missing key, the malformed key -- could not be reached by a test
 * without killing the test worker. They are the paths most worth testing,
 * being the ones an operator meets on a bad day.
 */

import { readFileSync } from "node:fs";
import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey, PrivateKey } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";

/** `RELAY_PORT`'s default -- matches the design spec's `/ip4/0.0.0.0/tcp/9090/ws` example. */
export const DEFAULT_RELAY_PORT = 9090;

/**
 * Where `RELAY_KEY_PATH` points when it is unset, and where
 * `apps/httpeers-stack`'s `pnpm bootstrap` writes the relay's signing key.
 * Relative to the process's working directory, so the reference stack running
 * this app from its own root still finds its own `.httpeers/relay.key`.
 */
export const DEFAULT_RELAY_KEY_PATH = "./.httpeers/relay.key";

/**
 * Who terminates TLS. A real fork rather than an inference, because the two
 * arrangements fail in opposite directions and neither failure is legible from
 * the other side.
 *
 * - `self` -- the relay terminates TLS itself and listens `wss`, reading
 *   `TLS_CERT`/`TLS_KEY`. A self-hoster on a dedicated box with no proxy in
 *   front of them needs this, and it is what the design originally asserted as
 *   the only arrangement.
 * - `edge` -- the relay listens plain `ws` and something in front of it (a
 *   reverse proxy, a platform edge) terminates TLS. **This is what our own
 *   deployment uses.** It also describes a laptop with no TLS at all, which is
 *   why it is the default: that is exactly today's behaviour.
 */
export type RelayTlsMode = "self" | "edge";

export interface RelayTlsMaterial {
  /** PEM certificate content -- already read from `TLS_CERT`'s file, not the path itself. */
  cert: string;
  /** PEM private key content -- already read from `TLS_KEY`'s file. */
  key: string;
}

/** Everything `startRelay` needs, with every default already applied. */
export interface ResolvedRelayConfig {
  /** The relay's signing key, and therefore its peerId. */
  privateKey: Ed25519PrivateKey;
  /** Where the key came from, named for the startup report. Never the key itself. */
  keySource: string;
  /** The addresses the relay binds. */
  listen: string[];
  /**
   * The addresses the relay tells peers to dial, when they differ from
   * `listen`. Empty means "announce what you listen on" -- libp2p's own
   * behaviour, and this relay's only behaviour before `RELAY_ANNOUNCE`.
   */
  announce: string[];
  tlsMode: RelayTlsMode;
  /** Present exactly when `tlsMode` is `self`. */
  tls?: RelayTlsMaterial;
  /** True when `RELAY_TLS` was set explicitly rather than defaulted. Reported, not enforced. */
  tlsModeExplicit: boolean;
}

/**
 * A misconfiguration an operator can fix, as opposed to a bug. Its `message`
 * is already written for a terminal -- multi-line, naming the variable at
 * fault and what a working value looks like -- so `main.ts` prints it verbatim
 * rather than decorating it.
 */
export class RelayConfigError extends Error {
  override readonly name = "RelayConfigError";
}

/** The environment as this module reads it. A plain record, so tests need no `process.env` surgery. */
export type RelayEnv = Record<string, string | undefined>;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireEd25519(key: PrivateKey, source: string): Ed25519PrivateKey {
  if (key.type !== "Ed25519") {
    throw new RelayConfigError(
      `relay: ${source} is a ${key.type} key -- only Ed25519 is supported (design note 05 §2).`,
    );
  }
  return key;
}

/**
 * Decodes a signing key from the base64 protobuf `RELAY_KEY` carries.
 *
 * `Buffer.from(s, "base64")` never throws -- it silently discards anything
 * that is not base64 and hands back whatever is left, so a truncated or
 * mistyped secret arrives here as a short, meaningless buffer and dies inside
 * protobuf parsing with a message about wire types. That is the "base64 stack
 * trace" this function exists to prevent: the operator's real problem is "the
 * secret is not what you think it is", and that is what they get told.
 */
function decodeRelayKeyFromBase64(base64: string): Ed25519PrivateKey {
  const trimmed = base64.trim();
  const bytes = trimmed === "" ? new Uint8Array(0) : Buffer.from(trimmed, "base64");
  if (bytes.byteLength === 0) {
    throw new RelayConfigError(
      [
        "relay: RELAY_KEY is set but decodes to nothing.",
        "relay: it must be the base64 of an Ed25519 private key in libp2p's protobuf encoding",
        "relay: -- on an existing key file that is `base64 -w0 .httpeers/relay.key`, and",
        'relay: "pnpm keygen" in @statewalker/httpeers-relay prints a fresh one.',
      ].join("\n"),
    );
  }
  let key: PrivateKey;
  try {
    key = privateKeyFromProtobuf(bytes);
  } catch (err) {
    throw new RelayConfigError(
      [
        `relay: RELAY_KEY is not a libp2p private key: ${describe(err)}`,
        "relay: it must be the base64 of the SAME protobuf RELAY_KEY_PATH holds as raw bytes",
        "relay: (@libp2p/crypto/keys' privateKeyToProtobuf). On an existing key file that is",
        'relay: `base64 -w0 .httpeers/relay.key`; "pnpm keygen" in @statewalker/httpeers-relay',
        "relay: prints a fresh one. A truncated or partly-pasted secret lands here.",
      ].join("\n"),
    );
  }
  return requireEd25519(key, "RELAY_KEY");
}

/**
 * The message an operator meets on a fresh host, and it names BOTH ways in.
 * Naming only `pnpm bootstrap` -- which is what this said while the relay was
 * still part of the demo -- is advice a container operator cannot act on:
 * there is no checkout to bootstrap and no volume to write to.
 */
function missingKeyGuidance(keyPath: string, explicitPath: boolean): string {
  return [
    `relay: no signing key found${explicitPath ? ` at "${keyPath}"` : ""}, and RELAY_KEY is not set.`,
    "relay: this relay needs a persistent identity. Two ways to give it one:",
    "relay:",
    "relay:   RELAY_KEY       base64 of an Ed25519 private key in libp2p's protobuf encoding.",
    "relay:                   Use this on a container host: a secret survives a redeploy and a",
    "relay:                   file on an ephemeral filesystem does not. Generate one with",
    'relay:                   "pnpm keygen" in @statewalker/httpeers-relay.',
    "relay:",
    `relay:   RELAY_KEY_PATH  the same protobuf as raw bytes on disk (default "${DEFAULT_RELAY_KEY_PATH}").`,
    "relay:                   Use this locally. In the reference stack, \"pnpm bootstrap\" writes",
    "relay:                   it for you.",
    "relay:",
    "relay: refusing to start with a freshly generated key: this relay's peerId is embedded in",
    "relay: every multiaddr peers dial, so an ephemeral identity would invalidate that config",
    "relay: on every restart.",
  ].join("\n");
}

/**
 * `RELAY_KEY` beats `RELAY_KEY_PATH`, and that ordering is the whole point of
 * T1. A container host's filesystem does not survive a deploy, so a relay that
 * can only read its identity from a file comes back with a **different
 * peerId** -- and this relay's peerId is embedded in every multiaddr peers
 * dial, so every published address, every `httpeers.json` and every invitation
 * breaks at once, with a symptom (peers cannot connect) that points nowhere
 * near here. A secret survives the deploy; a file does not.
 *
 * Neither present is still fatal, and still refuses to invent an identity, for
 * exactly that reason.
 */
export function loadRelayKey(source: {
  /** base64 protobuf. Wins over `keyPath` when present, however it was supplied. */
  key?: string | undefined;
  /** Defaults to `DEFAULT_RELAY_KEY_PATH`. */
  keyPath?: string | undefined;
}): { privateKey: Ed25519PrivateKey; keySource: string } {
  const raw = source.key;
  if (raw != null) {
    return { privateKey: decodeRelayKeyFromBase64(raw), keySource: "RELAY_KEY" };
  }

  const explicitPath = source.keyPath != null && source.keyPath.trim() !== "";
  const keyPath = explicitPath ? (source.keyPath as string).trim() : DEFAULT_RELAY_KEY_PATH;

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RelayConfigError(missingKeyGuidance(keyPath, explicitPath));
    }
    throw new RelayConfigError(
      `relay: could not read the signing key at "${keyPath}": ${describe(err)}`,
    );
  }

  let key: PrivateKey;
  try {
    key = privateKeyFromProtobuf(bytes);
  } catch (err) {
    throw new RelayConfigError(
      [
        `relay: the file at "${keyPath}" is not a libp2p private key: ${describe(err)}`,
        "relay: it must be the raw bytes of @libp2p/crypto/keys' privateKeyToProtobuf output.",
      ].join("\n"),
    );
  }
  return {
    privateKey: requireEd25519(key, `the key at "${keyPath}"`),
    keySource: `RELAY_KEY_PATH (${keyPath})`,
  };
}

/**
 * Parses `RELAY_ANNOUNCE`, and refuses the whole startup if any entry does not
 * parse. A relay that announces garbage is unreachable in a way nothing else
 * will diagnose: it starts cleanly, logs nothing unusual, holds reservations,
 * and every peer fails to dial it for a reason visible only in that peer's own
 * transport errors.
 */
function parseAnnounce(value: string): string[] {
  const entries = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (entries.length === 0) {
    throw new RelayConfigError(
      [
        "relay: RELAY_ANNOUNCE is set but contains no addresses.",
        "relay: either unset it -- the relay then announces what it listens on -- or give it a",
        'relay: comma-separated list of multiaddrs, e.g. "/dns4/relay.example.net/tcp/443/wss".',
      ].join("\n"),
    );
  }
  for (const entry of entries) {
    try {
      multiaddr(entry);
    } catch (err) {
      throw new RelayConfigError(
        [
          `relay: RELAY_ANNOUNCE entry "${entry}" is not a multiaddr: ${describe(err)}`,
          "relay: a relay behind a reverse proxy usually announces",
          'relay: "/dns4/<public-name>/tcp/443/wss".',
        ].join("\n"),
      );
    }
  }
  return entries;
}

function readPem(path: string, variable: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new RelayConfigError(
      [
        `relay: ${variable}="${path}" could not be read: ${describe(err)}`,
        `relay: ${variable} names a PEM FILE, not the PEM itself.`,
      ].join("\n"),
    );
  }
}

/**
 * The mode is read, not inferred -- except when `RELAY_TLS` is absent, where
 * inferring it from `TLS_CERT`/`TLS_KEY` reproduces exactly what this relay
 * did before the variable existed. An unset `RELAY_TLS` therefore never
 * changes an existing deployment's behaviour; setting it makes the choice
 * legible in the startup report, which is the point.
 *
 * `RELAY_TLS=self` with no certificate is refused rather than quietly
 * downgraded. Listening plain when the operator asked to terminate TLS is the
 * one outcome that looks like success and is not.
 */
function resolveTls(
  env: RelayEnv,
): Pick<ResolvedRelayConfig, "tlsMode" | "tls" | "tlsModeExplicit"> {
  const raw = env.RELAY_TLS?.trim();
  const explicit = raw != null && raw !== "";
  const hasMaterial = env.TLS_CERT != null && env.TLS_KEY != null;

  let mode: RelayTlsMode;
  if (!explicit) {
    mode = hasMaterial ? "self" : "edge";
  } else if (raw === "self" || raw === "edge") {
    mode = raw;
  } else {
    throw new RelayConfigError(
      [
        `relay: RELAY_TLS="${raw}" is not a mode.`,
        "relay:   self  the relay terminates TLS itself and listens wss, reading TLS_CERT/TLS_KEY.",
        "relay:   edge  the relay listens plain ws; a reverse proxy in front terminates TLS.",
        "relay: unset means edge, or self when TLS_CERT and TLS_KEY are both present.",
      ].join("\n"),
    );
  }

  if (mode === "edge") return { tlsMode: "edge", tlsModeExplicit: explicit };

  if (!hasMaterial) {
    throw new RelayConfigError(
      [
        "relay: RELAY_TLS=self, but TLS_CERT and TLS_KEY are not both set.",
        "relay: in self mode the relay terminates TLS itself and needs a certificate and a key,",
        "relay: each naming a PEM file it can read. If a reverse proxy terminates TLS in front of",
        "relay: this relay, you want RELAY_TLS=edge instead.",
      ].join("\n"),
    );
  }
  return {
    tlsMode: "self",
    tlsModeExplicit: explicit,
    tls: {
      cert: readPem(env.TLS_CERT as string, "TLS_CERT"),
      key: readPem(env.TLS_KEY as string, "TLS_KEY"),
    },
  };
}

function resolvePort(env: RelayEnv): number {
  const raw = env.RELAY_PORT;
  if (raw == null || raw.trim() === "") return DEFAULT_RELAY_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RelayConfigError(
      [
        `relay: RELAY_PORT="${raw}" is not a port number (0-65535).`,
        `relay: unset it to use the default, ${DEFAULT_RELAY_PORT}.`,
      ].join("\n"),
    );
  }
  return port;
}

/**
 * Reads the whole environment into a `ResolvedRelayConfig`, or throws a
 * `RelayConfigError` naming what to fix. Nothing is read from the environment
 * after this returns.
 */
export function resolveRelayConfig(env: RelayEnv = process.env): ResolvedRelayConfig {
  const { privateKey, keySource } = loadRelayKey({
    key: env.RELAY_KEY,
    keyPath: env.RELAY_KEY_PATH,
  });
  const tls = resolveTls(env);
  const port = resolvePort(env);
  const scheme = tls.tlsMode === "self" ? "wss" : "ws";
  return {
    privateKey,
    keySource,
    listen: [`/ip4/0.0.0.0/tcp/${port}/${scheme}`],
    announce: env.RELAY_ANNOUNCE != null ? parseAnnounce(env.RELAY_ANNOUNCE) : [],
    ...tls,
  };
}
