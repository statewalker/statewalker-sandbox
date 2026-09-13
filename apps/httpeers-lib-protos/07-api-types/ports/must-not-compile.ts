/**
 * THE NEGATIVE CONTROL, and the reason this rung is evidence rather than
 * decoration.
 *
 * A green `tsc` over two ports proves only that two files agree with a set of
 * declarations. It does NOT prove the declarations forbid anything. Each case
 * below is a defect a critic proved against the prose design; every one is
 * marked `@ts-expect-error`, which INVERTS the test — if the compiler ever
 * stops rejecting one of these, `tsc` fails with "unused @ts-expect-error" and
 * this file goes red.
 *
 * So: the two ports show the API is sufficient, and this file shows it is
 * restrictive. Neither alone is worth much.
 */

import {
  type Access,
  type Caller,
  callerOf,
  type Handler,
  type Landing,
  landing,
  type MeshRef,
  type Node,
  type PeerId,
  peerIdOf,
  pin,
} from "../src/api.js";

declare const node: Node;
declare const handler: Handler;
declare const access: Access;
declare const someRequest: Request;
declare const mesh: MeshRef;

// ---------------------------------------------------------------------------
// 1. A mount cannot be unpoliced.
//    The prose design had `policy?` optional, which made the security default
//    something nobody chose — and its own flagship example shipped an
//    unguarded mount.
// ---------------------------------------------------------------------------

// @ts-expect-error — `opts` is required, and `policy` within it.
node.serve("/images", handler);

// @ts-expect-error — an empty options object does not satisfy it either.
node.serve("/images", handler, {});

// ---------------------------------------------------------------------------
// 2. A policy is not a string.
//    `access.policy(...)` validates against the vocabulary at build time; a
//    bare string defers every mistake to the first request, which is how the
//    prototype got a mount that denied everything forever with no error.
// ---------------------------------------------------------------------------

// @ts-expect-error — a raw string is not a Policy.
node.serve("/images", handler, { policy: 'allow if resource("/images");' });

// ---------------------------------------------------------------------------
// 3. `callerOf` never returns `undefined`.
//    Overloading `undefined` to mean both "unbound — a bug" and "ours, so
//    forward it and attach our token" is what made the forward path fail OPEN.
//    The union has a `local` arm instead, and the accessor throws when nothing
//    was bound.
// ---------------------------------------------------------------------------

const caller: Caller = callerOf(someRequest);
// @ts-expect-error — there is no `undefined` in the union to compare against.
const _isUnbound: boolean = caller === undefined;

// @ts-expect-error — and no `peerId` on the anonymous/local arms without narrowing.
const _peer: PeerId = caller.peerId;

// ---------------------------------------------------------------------------
// 4. A key is bytes, not a string.
//    The prose design bound a string-valued store to a key whose bytes are a
//    libp2p protobuf, which would have silently re-minted every identity.
// ---------------------------------------------------------------------------

// @ts-expect-error — a base64 string is not a PrivateKey.
peerIdOf("CAESQAcl3mHf..." as string);

// ---------------------------------------------------------------------------
// 5. A Landing cannot be built by hand.
//    `appPath` validation was defeated by a backslash: `new URL("/\\evil.com/x",
//    "http://peer.local/").host === "evil.com"`, measured. The only constructor
//    is `landing()`, so an object literal must not typecheck.
// ---------------------------------------------------------------------------

declare const somePeer: PeerId;
// @ts-expect-error — AppPath is branded; a raw string cannot stand in for it.
const _l: Landing = { peerId: somePeer, appPath: "/app" };

// The sanctioned form, which does compile:
const ok: Landing = landing(somePeer, "/app");
pin(node, { landing: ok, basePath: "/ghost/", token: () => "t" });

// ---------------------------------------------------------------------------
// 6. A member's Access cannot mint.
//    Minting was added to the prose design by deleting the verifier's issuer,
//    leaving members unable to check a signature. Here `issuer` is optional and
//    present only where the mesh key is, so minting without checking is a
//    compile error rather than a runtime surprise.
// ---------------------------------------------------------------------------

// @ts-expect-error — `issuer` is possibly undefined on a member's access.
access.issuer.mint({ sub: somePeer, roles: ["member"], ttlMs: 60_000 });

// ---------------------------------------------------------------------------
// 7. An invitation id alone does not name a mesh.
//    `?invite=<id>` is what the Node hub prints and what every Playwright test
//    opens; without a mesh beside it there is nothing to join.
// ---------------------------------------------------------------------------

// @ts-expect-error — `mesh` is required on the id form.
const _j = { kind: "id" as const, invitationId: "abc" } satisfies import("../src/api.js").JoinInput;

// The sanctioned form:
const _j2 = {
  kind: "id" as const,
  invitationId: "abc",
  mesh,
} satisfies import("../src/api.js").JoinInput;

export const _control = { caller, ok, _j2 };
