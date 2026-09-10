/**
 * §6.6 on the lease itself — pin synchronously, resolve asynchronously, release
 * on failure.
 *
 * THIS FILE EXISTS BECAUSE THE MUTATION PASS ASKED FOR IT. Two mutations to
 * `createLease` — never unpinning on a failed resolution, and pinning after the
 * await instead of before — both survived the adapter suites, because those only
 * ever observe the lease INDIRECTLY, through whether a root resolution succeeds.
 * A leaked pin does not change that outcome, so nothing could see it. §5.3 says a
 * surviving mutation is either a weak test or uncovered code, and widening is
 * what tells them apart: widened, these turned out to be uncovered.
 */
import { describe, expect, it } from "vitest";
import { createLease } from "../src/handle-lease.js";

describe("§6.6 · handle lease", () => {
  it("pins before the first await, not after it", async () => {
    const lease = createLease<string>();
    let released!: () => void;
    const blocked = new Promise<void>((resolve) => {
      released = resolve;
    });

    const pending = lease.acquire("k", async () => {
      await blocked;
      return "handle";
    });

    // Observed SYNCHRONOUSLY after the call and before the resolution settles:
    // this is the whole of the rule, and the window it closes is the one in which
    // another holder's release would dispose the resource out from under a caller
    // that is still awaiting its own acquisition.
    expect([...lease.pinned]).toEqual(["k"]);

    released();
    expect(await pending).toBe("handle");
    expect([...lease.pinned]).toEqual(["k"]);
  });

  it("releases the pin when the resolution fails, leaving the table as it found it", async () => {
    const lease = createLease<string>();
    const before = [...lease.pinned];

    const failure = await lease
      .acquire("k", async () => {
        throw new Error("revoked");
      })
      .then(
        () => undefined,
        (e: Error) => e,
      );

    expect(failure?.message).toBe("revoked");
    expect([...lease.pinned]).toEqual(before);
  });

  it("keeps the pin through a failure that follows a success on the same key", async () => {
    // The symmetric pair of the case above: one holder succeeded and one failed,
    // so the failure must release ITS pin and not the other holder's. An `unpin`
    // that deleted the key outright rather than decrementing would take both.
    const lease = createLease<string>();
    await lease.acquire("k", async () => "live");
    await lease
      .acquire("k", async () => {
        throw new Error("revoked");
      })
      .catch(() => undefined);
    expect([...lease.pinned]).toEqual(["k"]);

    lease.release("k");
    expect([...lease.pinned]).toEqual([]);
  });

  it("counts holders rather than tracking presence", async () => {
    const lease = createLease<string>();
    await lease.acquire("k", async () => "a");
    await lease.acquire("k", async () => "a");
    lease.release("k");
    expect([...lease.pinned]).toEqual(["k"]); // one holder left
    lease.release("k");
    expect([...lease.pinned]).toEqual([]);
  });

  it("release by an unknown key is a no-op, not a decrement", async () => {
    const lease = createLease<string>();
    await lease.acquire("k", async () => "a");
    lease.release("nobody");
    lease.release("nobody");
    expect([...lease.pinned]).toEqual(["k"]);
  });

  it("pinned is a snapshot, not a live view a caller can mutate", async () => {
    const lease = createLease<string>();
    await lease.acquire("k", async () => "a");
    const snapshot = lease.pinned as Set<string>;
    snapshot.clear();
    expect([...lease.pinned]).toEqual(["k"]);
  });
});
