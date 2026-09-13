# 03 — Does a pure-pixel decoder read QR codes that a camera produced?

`pnpm test 03-qr-pixels`

**Answer: on single images, jsqr is one case behind the incumbent — not the
rout the prototype's history implies.** The gap is heavy blur, and everything
else they win or lose together.

Both decoders read the same twelve images of the same **real join blob** (302
characters, a 45×45 grid): jsqr on raw RGBA in Node, `html5-qrcode` through
`scanFileV2` in Chromium — the shipping call, not a lower-level API chosen to
flatter it.

## Measured, 2026-09-12

| Case | Stands for | jsqr | html5-qrcode |
|---|---|:--:|:--:|
| pristine | a screenshot | ✓ | ✓ |
| blur-1.5 | slightly out of focus | ✓ | ✓ |
| **blur-3** | **badly out of focus** | **✗** | **✓** |
| rotate-7 | phone at a slight angle | ✓ | ✓ |
| rotate-20 | phone held carelessly | ✓ | ✓ |
| perspective | photographed off-axis | ✓ | ✓ |
| jpeg-40 | camera-app JPEG ringing | ✓ | ✓ |
| low-contrast | dim screen or poor light | ✓ | ✓ |
| glare | reflection over one corner | ✗ | ✗ |
| small-160 | captured at a distance (~3 px/module) | ✗ | ✗ |
| small-blurred-160 | far away *and* out of focus | ✗ | ✗ |
| noise-and-blur | cheap sensor in low light | ✓ | ✓ |
| **total** | | **8/12** | **9/12** |

## What this says about the seam

**The isomorphic decoder is viable as *the* decoder for still images** —
scanning a saved photo, a screenshot, or an uploaded file, on either platform.
One degradation separates it from the incumbent.

**It does not follow that the camera path should change.** `qr-decode.ts`
records that jsqr was dropped because it failed on real photographs, and these
numbers do not contradict that, because they measure a different thing: the
shipping camera path scans **many frames of a live video stream**, where the
incumbent gets dozens of attempts at varying focus and angle, and the recorded
failure was of jsqr used single-shot. Three of the twelve cases here fail for
*both* decoders, which is what a single bad frame looks like — and a live
scanner simply takes another.

So the library should expose the pure decoder and let the browser keep the
incumbent for live capture:

- `decodeQr(image) → string | null` — pure, isomorphic, jsqr, for still images.
- A pluggable `decoder` so a page can pass `BarcodeDetector` or html5-qrcode.
- The camera loop stays in the app, out of the library. **Replacing the live
  scanner with jsqr remains unmeasured and is not sanctioned by this rung.**

## Not covered, and the honest gap

- **Real photographs.** Every image here is manufactured by `sharp` from a
  clean render. That is weaker evidence than a phone photo of a screen, and it
  is the reason the incumbent's advantage may be understated: real captures
  carry moiré against the screen's pixel grid, rolling-shutter skew and mixed
  lighting, none of which are modelled.
  **Point the run at real photos and it will score them:**
  `HTTPEERS_QR_PHOTOS=/path/to/folder pnpm test 03-qr-pixels`.
- **Live multi-frame scanning**, which is how the product actually scans.
- **`BarcodeDetector`**, unavailable in Chromium on Linux, so the browser's own
  built-in decoder was never in this comparison.
- **Encoding**, which is already pure (`qrModules`, `qrSvg`) and needs no rung.
- **Firefox and Safari.**
