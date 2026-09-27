/**
 * R-14 and A-19 are claims about a dependency GRAPH, not about behaviour, so they are
 * asserted by reading manifests. Asking a package about itself would prove nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(join(here, "../../httpeers.core/package.json"));

const TRANSPORT = /^(libp2p|@libp2p\/|@chainsafe\/libp2p|@multiformats\/multiaddr)/;

describe("dependency graph (R-14, A-19)", () => {
  it("the router and block A carry no transport dependency", () => {
    const pkg = JSON.parse(readFileSync(CORE, "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    const offenders = Object.keys(pkg.dependencies ?? {}).filter((d) => TRANSPORT.test(d));
    expect(
      offenders,
      `${pkg.name} depends on ${offenders.length} transport package(s): ${offenders.join(", ")}.\n` +
        `The spec (ADR-0005) puts the transport behind a seam so that core has nothing to import, ` +
        `and so block A can be built and tested with no network stack. This is divergence D-03.`,
    ).toEqual([]);
  });
});
