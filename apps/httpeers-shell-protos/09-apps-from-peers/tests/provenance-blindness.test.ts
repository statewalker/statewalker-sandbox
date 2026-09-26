// DERIVED-FROM-NOTE: 37-Prototype 9: Apps From Peers §1, §4
// DERIVED-FROM-NOTE: 38-Missing Parts and Next Prototypes §1, §2, §3
//
// The reject condition for this rung was "anything in the shell that branches
// on provenance". A rung whose answer is a NEGATIVE needs the negative
// asserted, not inferred from a rendering test passing — so these tests read
// the render path itself, and pin the two gaps that a green suite here would
// otherwise be read as closing.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { shellCatalog } from "../../lib/catalog.js";
import { createPeerTransport, mountPeerApp } from "../../lib/peer.js";
import type { A2uiMessage } from "../../lib/renderer.js";

// Resolved from the vitest root (this app) rather than from `import.meta.url`:
// under happy-dom `import.meta.url` is not a file: URL, and fileURLToPath
// silently yields a path relative to the DOM's origin instead of failing.
const read = (file: string): string => readFileSync(resolve(process.cwd(), "lib", file), "utf8");

/** Source with comments and string literals removed — executable code only. */
const codeOf = (file: string): string =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");

describe("nothing in the render path branches on provenance", () => {
  /**
   * The claim of note 01, re-tested here. Rendering identically (see
   * apps-from-peers.test.ts) shows the two paths AGREE TODAY; it does not show
   * that the shell cannot tell them apart. This does: the files that build the
   * DOM contain no provenance vocabulary in executable code at all, so there
   * is nothing for a future branch to branch on.
   */
  it.each(["renderer.ts", "mount.ts", "basecoat.ts", "dock.ts", "catalog.ts"])(
    "lib/%s names no peer, remote, provenance or sandbox concept in code",
    (file) => {
      const code = codeOf(file);
      const hits = [
        ...code.matchAll(/\b(peer|peerId|provenance|remote|untrusted|sandbox|isLocal)\b/gi),
      ].map((m) => m[0]);
      expect(hits).toEqual([]);
      // Guard against the stripper silently eating the file: comments are
      // gone, code is not.
      expect(code.length).toBeGreaterThan(200);
      expect(code).toContain("export");
    },
  );

  it("mountPeerApp's message loop does nothing but hand the message to the renderer", () => {
    // The one file that IS allowed to say "peer" must still not act on it.
    // Mutation 2 in §4 added a pre-filter inside this loop; a filter, a
    // conditional or a rewrite here would all show up as extra statements.
    const code = codeOf("peer.ts");
    const loop =
      /for\s+await\s*\(const\s+message\s+of\s+transport\.messages\(\)\)\s*\{([\s\S]*?)\n\s{2}\}/.exec(
        code,
      );
    expect(loop, "the message loop was not found — the shape of peer.ts changed").not.toBeNull();
    expect((loop?.[1] ?? "").trim()).toBe("renderer.handle(message);");
  });

  it("hands the renderer a catalogue and options that carry no peer identity", async () => {
    const code = codeOf("peer.ts");
    // createRenderer is called with exactly (container, catalog, options).
    // A fourth argument, or an options key naming the peer, would be the
    // leak — and would not be caught by any DOM comparison.
    expect(code).toMatch(/createRenderer\(\s*container,\s*catalog,\s*\{/);
    expect(/createRenderer\([^)]*peerId/.test(code)).toBe(false);
  });
});

describe("the transport's own origin is opaque", () => {
  /**
   * §4, mutation 3 — THE ONE THAT ESCAPED. The old suite asserted the DOCK's
   * stored origin carried no peer structure and never checked the TRANSPORT's
   * own, so a transport emitting `{"peerId":"...","transport":"libp2p"}`
   * passed everything. Both sides are asserted here, and the transport side
   * first, because it is the one that was missed.
   */
  it("is a path, and is not valid JSON", () => {
    const transport = createPeerTransport({
      peerId: "12D3KooWabc",
      async *messages() {},
    });

    expect(transport.origin).toBe("/peer/12D3KooWabc/");
    expect(() => JSON.parse(transport.origin)).toThrow();
    expect(transport.origin.startsWith("/")).toBe(true);
    expect(transport.origin).not.toMatch(/[{}[\]":]/);
  });

  it("stays the identical string once it reaches a mount — nothing enriches it", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const transport = createPeerTransport({
      peerId: "12D3KooWabc",
      async *messages(): AsyncGenerator<A2uiMessage> {
        yield {
          version: "v0.9.1",
          createSurface: { surfaceId: "s", catalogId: shellCatalog.catalogId },
        };
      },
    });
    const mount = await mountPeerApp(root, transport, shellCatalog);
    expect(mount.origin).toBe(transport.origin);
    expect(() => JSON.parse(mount.origin)).toThrow();
  });

  it("cannot be talked into structure by a hostile peer id", () => {
    // A peer id is opaque to the shell, so a peer that names itself with
    // JSON gets no help: the origin remains a path with the id inside it.
    const transport = createPeerTransport({
      peerId: '{"transport":"libp2p"}',
      async *messages() {},
    });
    expect(() => JSON.parse(transport.origin)).toThrow();
    expect(transport.origin.startsWith("/peer/")).toBe(true);
  });
});

describe("the gaps this rung leaves open", () => {
  /**
   * These tests pass by DEMONSTRATING AN ABSENCE. They exist so that a green
   * run of this rung cannot be read as "peer-served apps are safe". When the
   * missing mechanism is built, these tests are the ones that must change —
   * which is exactly what makes the gap visible rather than forgotten.
   */
  it("serves an application from a peer that holds NO capability whatsoever (note 38 §3)", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    // No token, no biscuit, no right, no allow-list. Nothing is consulted.
    const mount = await mountPeerApp(
      root,
      createPeerTransport({
        peerId: "an-entirely-unknown-peer",
        async *messages(): AsyncGenerator<A2uiMessage> {
          yield {
            version: "v0.9.1",
            createSurface: { surfaceId: "s", catalogId: shellCatalog.catalogId },
          };
          yield {
            version: "v0.9.1",
            updateComponents: {
              surfaceId: "s",
              components: [{ id: "root", component: "Text", text: "I am here uninvited" }],
            },
          };
        },
      }),
      shellCatalog,
    );

    // It rendered. The catalogue bounded WHAT it could express; nothing
    // asked WHETHER it was allowed to express anything at all. Rung 8 built
    // the machinery for that question and the two have never met.
    expect(root.textContent).toBe("I am here uninvited");
    expect(mount.renderer.surfaces()).toEqual(["s"]);

    // Asserted at the API surface too, so the gap cannot be closed silently:
    // mountPeerApp takes (container, transport, catalog, options) and there
    // is no parameter through which a capability could be supplied.
    expect(mountPeerApp.length).toBe(3); // the 4th has a default
    expect(codeOf("peer.ts")).not.toMatch(/\b(enablement|capability|authoriz|biscuit|allowed)\b/i);
  });

  it("has no mechanism that would make provenance blindness true rather than assumed (note 38 §1)", () => {
    // The ServiceWorker route installation that would make a peer-served app
    // addressable as an ordinary URL does not exist anywhere in the shell.
    // Until it does, "the shell cannot tell" rests on the fake transport
    // handing it the same messages a local module would.
    for (const file of ["peer.ts", "renderer.ts", "mount.ts", "dock.ts"]) {
      expect(codeOf(file)).not.toMatch(/serviceWorker|navigator\.|fetch\(|registerRoute/i);
    }
  });

  it("drains the stream to completion, so it fits a handshake and not a session (note 38 §2)", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let delivered = 0;
    // The last message waits on a gate this test opens, not on a timer: "5 ms
    // outlasts two setTimeout(0) ticks" does not hold on a loaded machine, and
    // this test failed on CI when it did not.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mount = mountPeerApp(
      root,
      createPeerTransport({
        peerId: "chatty",
        async *messages(): AsyncGenerator<A2uiMessage> {
          yield {
            version: "v0.9.1",
            createSurface: { surfaceId: "s", catalogId: shellCatalog.catalogId },
          };
          delivered++;
          yield {
            version: "v0.9.1",
            updateComponents: {
              surfaceId: "s",
              components: [{ id: "root", component: "Text", text: "first" }],
            },
          };
          delivered++;
          await gate;
          yield {
            version: "v0.9.1",
            updateComponents: {
              surfaceId: "s",
              components: [{ id: "root", component: "Text", text: "second" }],
            },
          };
          delivered++;
        },
      }),
      shellCatalog,
    );

    // Content IS in the DOM before the promise settles — rendering is
    // incremental — but the caller gets no handle until the stream ENDS.
    // A live peer's stream never ends, so a long-lived version of this
    // function cannot return at all.
    await new Promise((r) => setTimeout(r, 0));
    expect(delivered).toBeGreaterThan(0);
    let settled = false;
    void mount.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    release();
    await mount;
    expect(delivered).toBe(3);
    expect(root.textContent).toBe("second");
  });
});
