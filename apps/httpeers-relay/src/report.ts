/**
 * What the relay prints when it comes up, as data rather than as
 * `console.log` calls.
 *
 * WHY THIS IS A FUNCTION AND NOT A PILE OF LOGGING. Two of the three things
 * this relay must tell an operator are *warnings about configurations that
 * otherwise look like success*: an edge-mode relay announcing a plain `ws`
 * address, and a relay whose port is unencrypted. Both are invisible from
 * inside the process -- it starts, it listens, it holds reservations, and the
 * only symptom is browsers failing to connect somewhere else entirely. A
 * warning nobody can test is a warning that quietly stops being emitted, so
 * the text is produced here, returned, and asserted by
 * `tests/report.test.ts`; `main.ts` only prints it.
 */

import { multiaddr } from "@multiformats/multiaddr";
import type { ResolvedRelayConfig } from "./config.js";

export interface RelayStartupReport {
  /** The operator-facing block, in order. One paste into an issue. */
  lines: string[];
  /**
   * Configurations that start cleanly and do not work. Printed to stderr and
   * kept separate from `lines` so a log scraper can find them.
   */
  warnings: string[];
}

/** True when this multiaddr carries TLS -- either `/wss` or the expanded `/tls/ws`. */
function isEncrypted(addr: string): boolean {
  try {
    const names = multiaddr(addr)
      .getComponents()
      .map((c) => c.name);
    return names.includes("wss") || names.includes("tls");
  } catch {
    // Unparseable addresses are refused at config time, so reaching here means
    // the address came from libp2p itself. Do not warn about it.
    return true;
  }
}

/**
 * Builds the startup block. `addrs` are the addresses libp2p actually
 * advertises after boot -- the announce addresses when there are any, the
 * listen addresses otherwise -- which is the honest thing to print, because
 * it is what a peer will be handed.
 */
export function relayStartupReport(
  config: ResolvedRelayConfig,
  peerId: string,
  addrs: string[],
): RelayStartupReport {
  const lines: string[] = [];
  const warnings: string[] = [];

  const rule = "relay: ------------------------------------------------------------";
  lines.push(rule);

  // THE PEER ID, ALWAYS, AND FIRST. It is the one value an operator must be
  // able to confirm did not change across a deploy: a relay that comes back
  // with a fresh identity starts perfectly and breaks every client, so
  // "the container started" is not evidence and this line is.
  lines.push(`relay: peerId     ${peerId}`);
  lines.push(`relay: key from   ${config.keySource}`);

  const defaulted = config.tlsModeExplicit ? "" : " (defaulted; set RELAY_TLS to make it explicit)";
  lines.push(`relay: tls mode   ${config.tlsMode}${defaulted}`);
  if (config.tlsMode === "edge") {
    lines.push("relay:            a reverse proxy in front of this relay terminates TLS. This");
    lines.push("relay:            relay's own port is UNENCRYPTED plain ws and must not be");
    lines.push("relay:            exposed directly.");
  } else {
    lines.push("relay:            this relay terminates TLS itself and listens wss.");
  }

  for (const addr of config.listen) lines.push(`relay: listen     ${addr}`);
  if (config.announce.length === 0) {
    lines.push("relay: announce   (same as listen -- RELAY_ANNOUNCE is not set)");
  } else {
    for (const addr of config.announce) lines.push(`relay: announce   ${addr}`);
  }

  // THE SUBNETWORK POLICY, because it decides who this relay will carry and
  // it is invisible from outside: an operator looking at a peer that cannot
  // reserve has no other way to tell an `open` relay from a `registered` one
  // whose list does not have their name on it.
  lines.push(`relay: mode       ${config.mode}`);
  if (config.mode === "open") {
    lines.push("relay:            any subnetwork name is accepted; peers announcing different");
    lines.push("relay:            names cannot reach each other through this relay.");
  } else {
    lines.push(
      `relay:            only these ${config.networks.length} subnetwork name(s) are accepted:`,
    );
    for (const network of config.networks) lines.push(`relay:              ${network.name}`);
  }
  lines.push("relay:            a peer that announces no name is refused -- there is no default.");

  lines.push("relay: addresses");
  for (const addr of addrs) lines.push(`relay:   ${addr}`);
  lines.push(rule);

  // `open` IGNORES `RELAY_NETWORKS` ENTIRELY, and an operator who set it
  // believes the opposite. This starts cleanly and carries every subnetwork
  // on the internet, which is a fine thing to do on purpose and a bad thing
  // to do by accident.
  if (config.mode === "open" && config.networksConfigured) {
    warnings.push(
      [
        "relay: WARNING: RELAY_NETWORKS is set, but RELAY_MODE is open -- the list is IGNORED.",
        "relay: an open relay accepts any subnetwork name a peer announces. If you meant to",
        "relay: accept only the names on that list, set RELAY_MODE=registered.",
      ].join("\n"),
    );
  }

  // T3's loud warning. `edge` means something else terminates TLS, so what
  // peers are told to dial has to be the TLS address -- and if it is not,
  // every browser on an https origin refuses the dial under the mixed-content
  // rule, silently, with nothing in this relay's logs.
  //
  // BOTH WARNINGS REQUIRE `RELAY_TLS=edge` TO HAVE BEEN CHOSEN, not merely
  // defaulted to. A laptop sets neither variable, lands in edge by default,
  // and announces a plain `ws` address entirely correctly -- warning there
  // would fire on every local `pnpm start`, and a warning that always fires
  // is one people learn to scroll past, which is exactly what would make the
  // real case below unnoticeable.
  if (config.tlsMode === "edge" && config.tlsModeExplicit) {
    const plain = config.announce.filter((addr) => !isEncrypted(addr));
    if (plain.length > 0) {
      warnings.push(
        [
          "relay: WARNING: RELAY_TLS=edge, but these announced addresses are not wss/tls:",
          ...plain.map((addr) => `relay:   ${addr}`),
          "relay: edge mode means a reverse proxy terminates TLS in front of this relay, so what",
          "relay: peers are told to dial must be the TLS address at the public name, e.g.",
          'relay: "/dns4/<public-name>/tcp/443/wss". Announcing a plain ws address presents as',
          "relay: browsers on an https origin silently failing to connect -- the mixed-content",
          "relay: rule refuses the dial -- with nothing in this relay's logs to point at it.",
        ].join("\n"),
      );
    } else if (config.announce.length === 0) {
      warnings.push(
        [
          "relay: NOTE: RELAY_TLS=edge with RELAY_ANNOUNCE unset. This relay is announcing the",
          "relay: plain address it binds, which is right on a laptop and wrong behind a reverse",
          "relay: proxy -- there, set RELAY_ANNOUNCE to the public wss address peers must dial.",
        ].join("\n"),
      );
    }
  }

  return { lines, warnings };
}
