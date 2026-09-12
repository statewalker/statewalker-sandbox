/**
 * The platform constructors, declared and never implemented.
 *
 * A port imports these exactly as an application would. Declaring them is what
 * makes the ports compile-only: if a port can be written against these
 * signatures, an implementation of the API can satisfy it — and if it cannot,
 * no implementation would have helped.
 */

import type {
  AccessFactory,
  IdentityStore,
  MeshMemory,
  RouteStore,
  Storage,
  TransportFactory,
} from "./api.js";

/** `httpeers-libp2p`. The factory shape: built after the mesh is known. */
export declare const libp2p: TransportFactory;

/** `httpeers-biscuit`. Built BY the mesh, so a verifier always knows its issuer. */
export declare const biscuit: AccessFactory;

// Storage adapters — the same three methods everywhere (rung 04).
export declare function memory(): Storage;
/** ./node */
export declare function disk(path: string): Storage;
/** ./browser */
export declare function idb(name?: string): Storage;

// Identity stores — keys are BYTES.
export declare function memoryIdentity(): IdentityStore;
/** ./node */
export declare function fileIdentity(path: string): IdentityStore;
/** ./browser */
export declare function idbIdentity(name?: string): IdentityStore;

// Mesh memory — which mesh this origin last joined.
export declare function memoryMesh(): MeshMemory;
/** ./browser */
export declare function idbMesh(name?: string): MeshMemory;

// Route persistence for the proxy — the secret split lives in the store.
/** ./browser */
export declare function localStorageRoutes(key?: string): RouteStore;
/** ./node */
export declare function fileRoutes(path: string): RouteStore;

// Hosting.
/** ./node — over @hono/node-server, which accepts a bare fetch handler. */
export declare function serveGateway(
  handler: (request: Request) => Promise<Response>,
  init?: { port?: number; hostname?: string },
): { address: string; close(): Promise<void> };

/** ./browser — the ServiceWorker edge. Cannot mount at "/": the dispatcher keys on the first segment. */
export declare function mountSameOrigin(init: {
  key: string;
  handler: (request: Request) => Promise<Response>;
  serviceWorkerUrl?: string;
}): Promise<{ baseUrl: string; stop(): Promise<void> }>;

/**
 * ./browser — the cross-origin relay.
 *
 * NOTE THE ASYMMETRY, and it is not a design choice: a ServiceWorker only
 * intercepts requests from the clients it controls, and a page on origin A is
 * not controlled by relay origin B's worker. So the hosting page gets `call()`,
 * and only content LOADED FROM the relay origin gets a fetchable URL.
 */
export declare function mountRelay(init: {
  key: string;
  handler: (request: Request) => Promise<Response>;
  relayUrl?: URL;
}): Promise<{
  /** For embedded content: `${baseUrl}~${key}/…`. */
  serviceUrl: string;
  /** For the hosting page itself. There is no URL it could fetch instead. */
  call(request: Request): Promise<Response>;
  stop(): Promise<void>;
}>;
