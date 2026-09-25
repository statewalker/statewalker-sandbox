import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { invitationFromQrText } from "../src/browser/qr-decode.js";
import { qrModules, qrSvg } from "../src/browser/qr-encode.js";

/** A real join blob, the shape and length the hub actually mints (315 chars). */
const BLOB =
  "eyJyZWxheUFkZHJzIjpbIi9kbnM0L3JlbGF5Lmh0dHBlZXJzLm5ldC90Y3AvNDQzL3Rscy93cy9wMnAvMTJEM0tvb1dHemVXYlkyNlNSM0hDN3RZQmY5Qk5rSnA2dnlUNUNldkFKaVpRVkUyOWZGYSJdLCJodWJQZWVySWQiOiIxMkQzS29vV1BRSzQyMXJUdUtpNFloQ1FjZ1lpeThKcVliWVhUQXNWM3ZMZGtrMm5KV2FCIiwiaW52aXRhdGlvbklkIjoiZWFlNmJlNjgtMWMwNi00MGE4LTlhZjMtZDkxODIxN2JjNGVkIn0";

/** Render a module matrix to RGBA pixels, `scale` device pixels per module, with a quiet zone. */
function rasterise(modules: boolean[][], scale = 4, quiet = 4) {
  const n = modules.length;
  const size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!modules[y]?.[x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (x + quiet) * scale + dx;
          const py = (y + quiet) * scale + dy;
          const i = (py * size + px) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, size };
}

describe("qrSvg / qrModules", () => {
  // THE TEST THAT MATTERS: encode a real invitation, turn it into actual
  // pixels, and decode those pixels with the same library the pages use. If
  // the payload were too large for the chosen version, or the module matrix
  // were transposed, or the quiet zone were missing, this fails. Mocking the
  // decoder would prove none of it.
  it("round-trips a real join blob through pixels", () => {
    const { data, size } = rasterise(qrModules(BLOB));
    const decoded = jsQR(data, size, size);
    expect(decoded?.data).toBe(BLOB);
  });

  it("round-trips a short code too, so version selection is not hard-coded", () => {
    const { data, size } = rasterise(qrModules("hello-mesh"));
    expect(jsQR(data, size, size)?.data).toBe("hello-mesh");
  });

  it("produces an svg that carries the module count and no script", () => {
    const svg = qrSvg(BLOB);
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain("viewBox");
    expect(svg).not.toMatch(/<script|onload=/i);
  });

  it("refuses an empty payload rather than emitting an unscannable square", () => {
    expect(() => qrSvg("")).toThrow(/empty/i);
  });
});

describe("invitationFromQrText", () => {
  it("accepts the bare code the hub mints", () => {
    expect(invitationFromQrText(BLOB)).toBe(BLOB);
  });

  it("trims surrounding whitespace a decoder may include", () => {
    expect(invitationFromQrText(`  ${BLOB}\n`)).toBe(BLOB);
  });

  // A QR that decodes fine but holds something else is a DIFFERENT failure
  // from no QR at all: one means get another code, the other means retake the
  // photo. The caller can only say which if this distinguishes them.
  it("rejects a QR that is not an invitation", () => {
    expect(invitationFromQrText("https://example.com/")).toBeNull();
    expect(invitationFromQrText("WIFI:S=cafe;;")).toBeNull();
    expect(invitationFromQrText("")).toBeNull();
  });

  it("also accepts a ?join= link, since a phone camera may hand one over", () => {
    expect(invitationFromQrText(`https://app.httpeers.net/?join=${BLOB}`)).toBe(BLOB);
  });
});
