/**
 * Browser-safe shim that re-exports `just-bash/browser` plus the
 * `decodeBytesToUtf8` helper that the browser bundle accidentally omits.
 *
 * Why this exists
 * ---------------
 * just-bash@3.0.1 ships two entries:
 *   - the default ("import"/"module" condition) bundle, which executes
 *     `createRequire(import.meta.url)` at module init for `re2js`'s dynamic
 *     loading. Not browser-safe — Vite's `node:module` shim doesn't expose
 *     `createRequire`, so the page throws on first script execution.
 *   - the `./browser` subpath bundle, which IS browser-safe but does not
 *     re-export `decodeBytesToUtf8` (or other encoding helpers).
 *
 * `@just-bash/executor@1.0.2` (which we use for the Flue-tool → bash-command
 * bridge) imports `decodeBytesToUtf8` from `just-bash`. With the browser
 * entry that import resolves to `undefined`; with the default entry the page
 * blows up before any code runs.
 *
 * The Vite config aliases `just-bash` to this shim — we get the browser
 * bundle's exports PLUS a hand-rolled `decodeBytesToUtf8`. When upstream
 * fixes the export gap, delete this file and the alias.
 *
 * The shim is in `src/lib-host/` (not `src/lib/`) because it's a build-time
 * workaround for the host application's specific dependency set; the library
 * code under `src/lib/` consumes `just-bash` symbols normally.
 */

export * from "just-bash/browser";

/**
 * Decode a `ByteString` (latin1-packed JS string where each `char` is one
 * byte 0–255) as UTF-8. Mirrors the canonical implementation in
 * `just-bash/dist/encoding.js`: turn the latin1 string into a Uint8Array,
 * then `TextDecoder("utf-8")` it. Falls back to the raw latin1 view if the
 * bytes are not valid UTF-8 — matches the upstream behaviour.
 */
export function decodeBytesToUtf8(bytes: string): string {
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    buf[i] = bytes.charCodeAt(i) & 0xff;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return bytes;
  }
}
