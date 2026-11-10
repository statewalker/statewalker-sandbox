/**
 * R2: X6a's whole Node suite (git-identical .idx for native-git packs, crafted packs, hostile
 * packs, memory on deep chains) re-run against this slice's index-pack: the X6a module is replaced
 * by this one before X6a's test file is loaded.
 */
import { vi } from "vitest";

vi.mock("../../12-index-pack/src/index-pack.js", async () => await import("../src/index-pack.js"));

await import("../../12-index-pack/tests/node.test.js");
