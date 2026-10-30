/**
 * The Bridge (Node and Bun only): a locked-down loopback relay from the
 * PeerShare page to the Sharer's local Services, with per-Guest cookie jars.
 */

export { type BridgeInit, createBridge } from "./bridge.js";
export { type Listening, listenLoopback } from "./serve.js";
