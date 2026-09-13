/**
 * 03 — Does a pure-pixel decoder read QR codes that a camera produced?
 *
 * The payload is a REAL join blob built by the stack's own `encodeJoinBlob`,
 * so the code is the size the product actually generates (a ~45×45 grid for
 * ~315 characters) rather than a short test string that would decode far more
 * easily than the real thing.
 *
 * Two decoders on one corpus:
 *   - jsqr, in Node, on raw RGBA — the isomorphic candidate.
 *   - html5-qrcode, in Chromium, on the same images — what ships today, and
 *     what jsqr was dropped in favour of.
 *
 * The comparison is the point. A pure-pixel decoder that loses badly to the
 * incumbent on camera-shaped input is a server-side tool, not *the* decoder.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { encodeJoinBlob } from "@statewalker/httpeers-stack/src/browser/join-blob.js";
import jsQR from "jsqr";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeInChromium } from "../src/browser-decode.js";
import { buildCorpus, type Case, toRgba } from "../src/corpus.js";

/** A join blob of the shape the hub page really mints: relay multiaddr, hub peerId, invitation uuid. */
const PAYLOAD = encodeJoinBlob({
  relayAddrs: [
    "/ip4/203.0.113.42/tcp/9090/ws/p2p/12D3KooWPbzaA61nmJyktyUaszpxftMLqrCh7Yd1UvJ9ZuQJYnBZ",
  ],
  hubPeerId: "12D3KooWEHUcCvsmTLLoQG28Y2PDkUfddP1WmdSKwY1sSxfANcxR",
  invitationId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
});

/** Real photographs, if someone pointed the run at a folder of them. */
const PHOTO_DIR = process.env.HTTPEERS_QR_PHOTOS;

interface Score {
  name: string;
  stands_for: string;
  jsqr: boolean;
  html5: boolean;
}

describe("03 — pure-pixel QR decoding", () => {
  let cases: Case[];
  let photos: Case[] = [];
  let scores: Score[] = [];
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-qr-"));
    cases = await buildCorpus(PAYLOAD);

    if (PHOTO_DIR != null) {
      photos = readdirSync(PHOTO_DIR)
        .filter((f) => [".png", ".jpg", ".jpeg", ".webp"].includes(extname(f).toLowerCase()))
        .map((f) => ({
          name: `photo:${f}`,
          stands_for: "a real photograph",
          png: readFileSync(join(PHOTO_DIR, f)),
        }));
    }

    const all = [...cases, ...photos];
    // Written out so a failure can be looked at rather than guessed about.
    for (const c of all) writeFileSync(join(dir, `${c.name.replace(/[:/]/g, "_")}.png`), c.png);

    const html5 = await decodeInChromium(all.map((c) => ({ name: c.name, png: c.png })));

    scores = [];
    for (const c of all) {
      const img = await toRgba(c.png);
      const result = jsQR(img.data, img.width, img.height);
      scores.push({
        name: c.name,
        stands_for: c.stands_for,
        jsqr: result?.data === PAYLOAD,
        html5: html5[c.name] === PAYLOAD,
      });
    }

    const row = (s: Score): string =>
      `  ${s.jsqr ? "jsqr ✓" : "jsqr ✗"}  ${s.html5 ? "html5 ✓" : "html5 ✗"}  ${s.name} — ${s.stands_for}`;
    console.log(
      `\nDecoder scores (payload ${PAYLOAD.length} chars):\n${scores.map(row).join("\n")}\n`,
    );
  }, 300_000);

  afterAll(() => {
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  });

  it("CLAIM 1 — jsqr decodes a clean render of a real join blob", () => {
    const pristine = scores.find((s) => s.name === "pristine");
    expect(pristine?.jsqr).toBe(true);
  });

  it("CLAIM 2 — the incumbent decodes the clean render too, so the comparison is like-for-like", () => {
    const pristine = scores.find((s) => s.name === "pristine");
    expect(pristine?.html5).toBe(true);
  });

  it("CLAIM 3 — the two decoders are scored on every degradation, and the gap is recorded", () => {
    const synthetic = scores.filter((s) => !s.name.startsWith("photo:"));
    const jsqrWins = synthetic.filter((s) => s.jsqr).length;
    const html5Wins = synthetic.filter((s) => s.html5).length;
    // Not an assertion about which is better — the numbers are the result, and
    // the README carries them. This only pins that the run measured every case.
    expect(synthetic).toHaveLength(12);
    expect(jsqrWins + html5Wins).toBeGreaterThan(0);
  });

  it("CLAIM 4 — where a folder of real photographs was supplied, they are scored too", () => {
    if (PHOTO_DIR == null) {
      // Recorded rather than silently skipped: this rung's evidence is weaker
      // without real photographs, and the run says so.
      console.log("  (no HTTPEERS_QR_PHOTOS folder supplied — synthetic degradations only)");
      expect(photos).toHaveLength(0);
      return;
    }
    expect(photos.length).toBeGreaterThan(0);
  });
});
