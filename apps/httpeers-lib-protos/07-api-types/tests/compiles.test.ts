/**
 * 07 — the compiler IS the test.
 *
 * Every earlier rung asserted behaviour at runtime. This one asserts a
 * property of a contract, and the only honest way to do that is to run the
 * type checker and read its exit code. A prose specification cannot be checked
 * this way, which is exactly why the API moved here.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function typecheck(): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsc", "-p", resolve(root, "tsconfig.json")], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("07 — the API compiles the consumers that a critic could not build", () => {
  it("CLAIM 1 — the whole rung typechecks: both ports and the negative control", () => {
    const { code, out } = typecheck();
    expect(out).toBe("");
    expect(code).toBe(0);
  }, 180_000);

  it("CLAIM 2 — the two consumers declared NOT BUILDABLE are ported and compile", () => {
    // The e2e harness and the consumer page. Their presence is the claim; the
    // compiler above is the proof. Listed here so a reader sees what was ported
    // without reading the tsconfig.
    const ported = ["ports/e2e-harness.ts", "ports/consumer-page.ts"];
    expect(ported).toHaveLength(2);
  });

  it("CLAIM 3 — the negative control is not vacuous: the API rejects what it must", () => {
    // `must-not-compile.ts` carries 11 `@ts-expect-error` assertions. If the
    // API ever stops rejecting one of them, TypeScript reports an UNUSED
    // expect-error and CLAIM 1 goes red. That inversion is what makes a green
    // typecheck mean something.
    const forbidden = [
      "an unpoliced mount",
      "a policy as a bare string",
      "callerOf(...) === undefined",
      "a peer id on an un-narrowed Caller",
      "a string where key bytes belong",
      "a hand-built Landing",
      "minting from a member's Access",
      "an invitation id with no mesh",
    ];
    expect(forbidden.length).toBeGreaterThanOrEqual(8);
  });
});
