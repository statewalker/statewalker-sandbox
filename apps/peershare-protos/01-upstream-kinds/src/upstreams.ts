/**
 * Upstream kinds: how the Sharer's tab reaches a Service's local URL.
 */

import { MESH_CREDENTIAL_HEADERS } from "@statewalker/httpeers-core";
import { MARKER, type Upstream, urlUpstream } from "@statewalker/webrun-http-proxy";

/** Which local URL the Bridge relays to. Set by the Sharer, never by a Guest. */
export const BRIDGE_TARGET_HEADER = "x-peershare-target";
/** The Pairing token the Bridge printed at launch. */
export const BRIDGE_TOKEN_HEADER = "x-peershare-bridge-token";
/** Marks the Bridge's own responses, so they are never mistaken for the Service's. */
export const BRIDGE_MARKER = "x-peershare-bridge";

export type UpstreamConfig =
  | { kind: "direct"; target: string }
  | { kind: "bridged"; target: string; bridge: { base: string; token: string } };

export function createUpstream(config: UpstreamConfig): Upstream {
  // A Guest's membership token and peer id are consumed by the mesh hop:
  // Dirk's app has no business seeing them, whichever way it is reached.
  // A Guest's copy of the Bridge headers goes too: the target and token are
  // the Sharer's to set, and Direct would otherwise hand them to the app.
  const stripRequestHeaders = [
    ...MESH_CREDENTIAL_HEADERS,
    BRIDGE_TARGET_HEADER,
    BRIDGE_TOKEN_HEADER,
  ];
  if (config.kind === "direct") return urlUpstream({ base: config.target, stripRequestHeaders });
  // Bridged is a URL upstream too: re-issued at the Bridge instead of the
  // Service, with the real target and the Pairing token as headers.
  const viaBridge = urlUpstream({
    base: config.bridge.base,
    stripRequestHeaders,
    headers: {
      [BRIDGE_TARGET_HEADER]: config.target,
      [BRIDGE_TOKEN_HEADER]: config.bridge.token,
    },
  });
  return async (request) => {
    const response = await viaBridge(request);
    // To `urlUpstream` the Bridge IS the upstream, so its "unreachable" means
    // the Bridge is not running, not that the Service is down.
    if (response.headers.get(MARKER) !== "upstream-unreachable") return response;
    const headers = new Headers(response.headers);
    headers.delete(MARKER);
    headers.set(BRIDGE_MARKER, "bridge-unreachable");
    return new Response(response.body, { status: response.status, headers });
  };
}

/** Which hop did not answer, read off an `Upstream`'s response; `undefined` when something did. */
export function unreachable(response: Response): "service" | "bridge" | undefined {
  const bridge = response.headers.get(BRIDGE_MARKER);
  if (bridge === "bridge-unreachable") return "bridge";
  if (bridge === "target-unreachable") return "service";
  if (response.headers.get(MARKER) === "upstream-unreachable") return "service";
  return undefined;
}
