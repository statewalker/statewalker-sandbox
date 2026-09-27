/**
 * biscuit-wasm reports `{ RunLimit: "Timeout" }` spuriously under CPU load, on
 * evaluations that take well under a millisecond. Believing it turns a busy
 * machine into a refused member: CI caught the image peer answering a
 * legitimate request with 403 "evaluation budget exhausted (Timeout)".
 *
 * The evaluations are pure, so a retry cannot turn a deny into an allow, and a
 * real exhaustion still fails closed on every attempt. These tests inject the
 * spurious report deterministically, one call site at a time, rather than
 * hoping for CPU contention.
 */
import { Authorizer } from "@biscuit-auth/biscuit-wasm";
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authorize, DEFAULT_RULES, deriveCapabilities } from "../src/rules.js";
import {
  isSpuriousTimeout,
  mintToken,
  retryOnSpuriousTimeout,
  verifyToken,
  warmUpTokens,
} from "../src/tokens.js";
import type { MeshClaims } from "../src/types.js";

const TIMEOUT = { RunLimit: "Timeout" };
const MEMBER = "12D3KooWMemberPeerIdForTests";

const member: MeshClaims = {
  sub: "peerA",
  iss: "hub",
  mesh: "hub",
  roles: ["member"],
  iat: 1_000,
  exp: 1_000_000,
  audience: "unrestricted",
};

/** The engine reports a spurious Timeout on its next `n` calls to `method`, then behaves. */
function spuriousTimeouts(method: "authorizeWithLimits" | "queryWithLimits", n = 1) {
  const original = Authorizer.prototype[method];
  let left = n;
  return vi.spyOn(Authorizer.prototype, method).mockImplementation(function (
    this: Authorizer,
    ...args: unknown[]
  ) {
    if (left > 0) {
      left--;
      throw TIMEOUT;
    }
    return Reflect.apply(original, this, args);
  });
}

let hubKey: Ed25519PrivateKey;
let hubPeerId: string;

beforeAll(async () => {
  // The warm-up runs a throwaway authorization of its own. Done first, so it
  // never consumes a Timeout injected for the call site under test.
  warmUpTokens();
  hubKey = await generateKeyPair("Ed25519");
  hubPeerId = peerIdFromPrivateKey(hubKey).toString();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retryOnSpuriousTimeout", () => {
  it("retries a Timeout and returns the answer", () => {
    let calls = 0;
    const answer = retryOnSpuriousTimeout(() => {
      calls++;
      if (calls === 1) throw TIMEOUT;
      return "allowed";
    });
    expect(answer).toBe("allowed");
    expect(calls).toBe(2);
  });

  it("never retries TooManyFacts, which counts work and is the real denial-of-service bound", () => {
    let calls = 0;
    expect(() =>
      retryOnSpuriousTimeout(() => {
        calls++;
        throw { RunLimit: "TooManyFacts" };
      }),
    ).toThrow();
    expect(calls).toBe(1);
  });

  it("never retries an ordinary failure", () => {
    let calls = 0;
    expect(() =>
      retryOnSpuriousTimeout(() => {
        calls++;
        throw new Error("failed check");
      }),
    ).toThrow("failed check");
    expect(calls).toBe(1);
  });

  it("gives up after a bounded number of attempts and rethrows the Timeout", () => {
    let calls = 0;
    let thrown: unknown;
    try {
      retryOnSpuriousTimeout(() => {
        calls++;
        throw TIMEOUT;
      });
    } catch (error) {
      thrown = error;
    }
    expect(isSpuriousTimeout(thrown)).toBe(true);
    expect(calls).toBe(3);
  });
});

describe("every engine call site survives one spurious Timeout", () => {
  it("authorize still allows a legitimate request", () => {
    spuriousTimeouts("authorizeWithLimits");
    const decision = authorize(
      DEFAULT_RULES,
      { operation: "GET", resource: "/test/echo", now: 2_000 },
      member,
    );
    expect(decision.allowed, decision.reason).toBe(true);
  });

  it("deriveCapabilities still derives the role's capabilities", () => {
    spuriousTimeouts("queryWithLimits");
    expect(deriveCapabilities(DEFAULT_RULES, ["member"]).has("std:test")).toBe(true);
  });

  it("verifyToken still accepts a valid token when authorizing times out once", async () => {
    const token = await mintToken({
      privateKey: hubKey,
      sub: MEMBER,
      roles: ["member"],
      ttlMs: 60_000,
      now: () => 1_000_000,
    });
    spuriousTimeouts("authorizeWithLimits");
    const claims = await verifyToken(token, {
      issuer: hubPeerId,
      connectionPeer: MEMBER,
      now: () => 1_000_000,
    });
    expect(claims.sub).toBe(MEMBER);
  });

  it("verifyToken still reads the claims when a query times out once", async () => {
    const token = await mintToken({
      privateKey: hubKey,
      sub: MEMBER,
      roles: ["member"],
      ttlMs: 60_000,
      now: () => 1_000_000,
    });
    spuriousTimeouts("queryWithLimits");
    const claims = await verifyToken(token, {
      issuer: hubPeerId,
      connectionPeer: MEMBER,
      now: () => 1_000_000,
    });
    expect(claims.roles).toEqual(["member"]);
  });

  it("a Timeout on every attempt still denies, so a real exhaustion fails closed", () => {
    spuriousTimeouts("authorizeWithLimits", 99);
    const decision = authorize(
      DEFAULT_RULES,
      { operation: "GET", resource: "/test/echo", now: 2_000 },
      member,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("evaluation budget exhausted (Timeout)");
  });
});
