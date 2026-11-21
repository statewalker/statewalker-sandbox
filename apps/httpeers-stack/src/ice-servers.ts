/**
 * The STUN servers the browser and hub nodes' `webRTC()` transport asks for
 * ICE candidates (httpeers#1).
 *
 * The mesh's own server comes first: `stun:stun.httpeers.net:3478`, STUN only
 * (no TURN), deployed from httpeers' `deploy/docker-compose.yml` (`stun`).
 * One public server stays behind it as a fallback, so a node still learns its
 * public address while ours is down. An unreachable server costs little:
 * `@libp2p/webrtc` trickles candidates as they come and never waits for
 * gathering to finish, so a silent server just contributes no `srflx`
 * candidate.
 *
 * Without this list `@libp2p/webrtc` used its own built-in list of four
 * public servers (Google, Twilio, Cloudflare, Mozilla). The same pair is
 * `HTTPEERS_ICE_SERVERS` in `@statewalker/httpeers-libp2p`, which this app
 * does not depend on.
 */

/** One ICE server, as `RTCConfiguration.iceServers` takes it. */
export interface IceServer {
  readonly urls: string;
}

/** The mesh's own STUN server. */
export const MESH_STUN_URL = "stun:stun.httpeers.net:3478";

/** The public STUN server behind it. */
export const PUBLIC_STUN_FALLBACK_URL = "stun:stun.l.google.com:19302";

/** The mesh's STUN server first, then one public fallback. */
export const ICE_SERVERS: readonly IceServer[] = Object.freeze([
  Object.freeze({ urls: MESH_STUN_URL }),
  Object.freeze({ urls: PUBLIC_STUN_FALLBACK_URL }),
]);

/**
 * The `webRTC()` init carrying `ICE_SERVERS`, as fresh, unfrozen copies. On
 * Node (the hub), node-datachannel's `RTCPeerConnection` rewrites each
 * entry's `urls` in place, and a frozen entry makes it throw ("Cannot assign
 * to read only property 'urls'"), which fails every WebRTC connection.
 */
export function webRTCInit(): { rtcConfiguration: { iceServers: { urls: string }[] } } {
  return { rtcConfiguration: { iceServers: ICE_SERVERS.map((s) => ({ ...s })) } };
}
