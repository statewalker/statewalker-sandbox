/**
 * R7: X6b1's whole Node suite (thin packs against git, refusals, memory, window, sweep, the
 * review cases) re-run with X6b1's module replaced by this one: `installPack` is a job run to
 * completion in one step.
 */
import { vi } from "vitest";

vi.mock("../../14-thin-packs/src/index-pack.js", async () => await import("../src/index-job.js"));

await import("../../14-thin-packs/tests/node.test.js");
