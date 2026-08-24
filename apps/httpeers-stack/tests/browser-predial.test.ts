/**
 * `preDialPeer`'s retry, and what a page is told when every attempt stalls.
 *
 * WHY A FAKE NODE AND NOT A REAL ONE. The failure this retry exists for is a
 * WebRTC handshake that stalls after signalling completes -- it happens in
 * roughly a third of real browser runs and cannot be provoked on demand, so a
 * test that waited for a genuine stall would be the flake it is meant to
 * close. What IS testable, and what the retry is, is the contract: dial again
 * when a dial fails, up to a bound, and stay single-shot for the caller that
 * has its own timer. The evidence that a retry actually clears a real stall is
 * measurement, not a test: nine stalls over sixteen runs of
 * `tests/e2e/browser.test.ts`, nine recoveries, every one in 103-195 ms. See
 * `../src/browser/join.ts`'s `PRE_DIAL_JOIN_ATTEMPTS`.
 */

import type { Libp2p } from "@statewalker/httpeers.core";
import { describe, expect, it } from "vitest";
import { PRE_DIAL_JOIN_ATTEMPTS, preDialPeer } from "../src/browser/join.js";
import { describeHubPreDialFailure } from "../src/browser/peer-runtime.js";

const RELAY = "/ip4/127.0.0.1/tcp/9090/ws/p2p/12D3KooWRelay";
const HUB = "12D3KooWHub";

/** libp2p's own shape for a dial that ran out of time. `name` is what the caller branches on. */
function timeoutError(): Error {
  const err = new Error("The operation timed out.");
  err.name = "TimeoutError";
  return err;
}

/**
 * A node whose `dial` fails `failures` times and then succeeds, recording
 * every address it was asked for.
 */
function fakeNode(failures: number, err: () => Error = timeoutError) {
  const dialled: string[] = [];
  const node = {
    dial: async (addr: { toString(): string }) => {
      dialled.push(addr.toString());
      if (dialled.length <= failures) throw err();
      return {} as never;
    },
  } as unknown as Libp2p;
  return { node, dialled };
}

describe("preDialPeer: the bound, and where it does not apply", () => {
  it("attempts: 1 means one dial -- the shape the keepalive asks for", async () => {
    // `startJoin`'s keepalive passes 1 EXPLICITLY, because its own timer is the
    // retry and an inner retry would multiply the two. It used to rely on the
    // default; there is no default any more (see `PreDialInit.attempts`), so
    // the intent is now stated at that call site rather than inherited here.
    const { node, dialled } = fakeNode(1);
    await expect(preDialPeer(node, RELAY, HUB, { attempts: 1 })).rejects.toThrow(/timed out/);
    expect(dialled).toHaveLength(1);
  });

  it("a joining peer retries, and one stall does not end the join", async () => {
    // The regression this pins: before the retry, a single stalled dial left
    // the page at "error" permanently, on a mesh that was working.
    const { node, dialled } = fakeNode(1);
    await preDialPeer(node, RELAY, HUB, { attempts: PRE_DIAL_JOIN_ATTEMPTS, retryDelayMs: 0 });
    expect(dialled).toHaveLength(2);
    // Every attempt dials the SAME composed address -- the `/webrtc` suffix is
    // what forces the upgrade, and a retry that dropped it would "succeed"
    // into a limited connection that refuses `/httpeers/1.0.0`.
    expect(new Set(dialled)).toEqual(new Set([`${RELAY}/p2p-circuit/webrtc/p2p/${HUB}`]));
  });

  it("two stalls do not either -- one retry was measurably not enough", async () => {
    const { node, dialled } = fakeNode(2);
    await preDialPeer(node, RELAY, HUB, { attempts: PRE_DIAL_JOIN_ATTEMPTS, retryDelayMs: 0 });
    expect(dialled).toHaveLength(3);
  });

  it("the bound holds, and the last failure is what the caller sees", async () => {
    // Bounded, not persistent: a page that retried forever would hang instead
    // of telling anyone, which is the failure mode this whole change is about.
    const { node, dialled } = fakeNode(Number.POSITIVE_INFINITY);
    await expect(
      preDialPeer(node, RELAY, HUB, { attempts: PRE_DIAL_JOIN_ATTEMPTS, retryDelayMs: 0 }),
    ).rejects.toThrow(/timed out/);
    expect(dialled).toHaveLength(PRE_DIAL_JOIN_ATTEMPTS);
  });

  it("a non-timeout failure is retried too, and still bounded", async () => {
    // The retry is about the dial not completing, whatever the reason. A
    // subnetwork mismatch (PERMISSION_DENIED) is not transient and will use up
    // its attempts -- which costs a bounded amount and keeps this function
    // from having to classify libp2p's errors.
    const { node, dialled } = fakeNode(1, () => new Error("failed to connect via relay"));
    await preDialPeer(node, RELAY, HUB, { attempts: 2, retryDelayMs: 0 });
    expect(dialled).toHaveLength(2);
  });
});

describe("describeHubPreDialFailure: a stall does not blame the hub", () => {
  const base = { hubPeerId: HUB, relayAddr: RELAY, attempts: PRE_DIAL_JOIN_ATTEMPTS };

  it("says the connection stalled, names the attempts, and offers the remedy", () => {
    const message = describeHubPreDialFailure({ ...base, err: timeoutError() });
    expect(message).toContain("stalled");
    expect(message).toContain(`${PRE_DIAL_JOIN_ATTEMPTS} times`);
    expect(message).toContain("reloading the page");
  });

  it("does NOT send the operator to check the hub's reservation", () => {
    // THE POINT OF THIS FUNCTION. At the instant of a stall the hub was
    // measured holding its reservation, listed by the relay, and serving
    // another page over that same relay -- four times out of four. The old
    // message said "check that the hub process is running", which is advice to
    // go and inspect the one component that is provably working.
    const message = describeHubPreDialFailure({ ...base, err: timeoutError() });
    expect(message).not.toContain("check that the hub process is running");
    expect(message).not.toContain("its OWN circuit reservation");
  });

  it("finds the timeout through a wrapper, which is how libp2p reports it", () => {
    // libp2p wraps per-address failures; reading only the outer `name` would
    // classify every stall as an ordinary unreachability.
    const wrapped = new Error("all addresses failed", { cause: timeoutError() });
    expect(describeHubPreDialFailure({ ...base, err: wrapped })).toContain("stalled");

    const aggregated = Object.assign(new Error("all addresses failed"), {
      errors: [new Error("something else"), timeoutError()],
    });
    expect(describeHubPreDialFailure({ ...base, err: aggregated })).toContain("stalled");
  });

  it("keeps the reachability guidance for a failure that is NOT a timeout", () => {
    // A hub that genuinely holds no reservation is a real case, and the
    // original advice is right for it. Both messages have to survive.
    const message = describeHubPreDialFailure({
      ...base,
      err: new Error("failed to connect via relay with status NO_RESERVATION"),
    });
    expect(message).toContain("its OWN circuit reservation");
    expect(message).not.toContain("stalled");
  });
});
