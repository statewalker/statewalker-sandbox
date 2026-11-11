// Strings and bytes in the encodings file APIs take (Node's BufferEncoding, as just-bash uses
// it): "utf8" text, "latin1"/"binary" (one char per byte), "ascii", "base64" and "hex".

export type Encoding = "utf8" | "utf-8" | "ascii" | "binary" | "latin1" | "base64" | "hex";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

const norm = (e: unknown) => String(e ?? "utf8").toLowerCase();

/** The encoding named by an option: a string, or `{ encoding }`. */
export function encodingOf(o: unknown): string | undefined {
  if (typeof o === "string") return o;
  if (o && typeof o === "object" && "encoding" in o) {
    const e = (o as { encoding?: unknown }).encoding;
    return e == null ? undefined : String(e);
  }
  return undefined;
}

export const isUtf8 = (e: unknown) => {
  const n = norm(e);
  return n === "utf8" || n === "utf-8";
};

/** Bytes of a Uint8Array, any ArrayBuffer view or an ArrayBuffer; undefined for anything else. */
export function asBytes(d: unknown): Uint8Array | undefined {
  if (d instanceof Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  return undefined;
}

/** A string in `encoding` as the bytes it stands for. */
export function stringToBytes(s: string, encoding?: unknown): Uint8Array {
  switch (norm(encoding)) {
    case "utf8":
    case "utf-8":
      return enc.encode(s);
    case "latin1":
    case "binary":
      return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
    case "ascii":
      return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0x7f);
    case "base64":
      return Uint8Array.from(atob(s.replace(/[^A-Za-z0-9+/=]/g, "")), (c) => c.charCodeAt(0));
    case "hex": {
      const clean = s.length % 2 ? s.slice(0, -1) : s;
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i++) {
        const b = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        if (Number.isNaN(b)) return out.subarray(0, i);
        out[i] = b;
      }
      return out;
    }
    default:
      throw Object.assign(new Error(`EINVAL: unknown encoding '${String(encoding)}'`), {
        code: "EINVAL",
      });
  }
}

/** Bytes as a string in `encoding`. */
export function bytesToString(b: Uint8Array, encoding?: unknown): string {
  switch (norm(encoding)) {
    case "utf8":
    case "utf-8":
      return dec.decode(b);
    case "latin1":
    case "binary": {
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000)
        s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return s;
    }
    case "ascii": {
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000)
        s += String.fromCharCode(...Array.from(b.subarray(i, i + 0x8000), (x) => x & 0x7f));
      return s;
    }
    case "base64":
      return btoa(bytesToString(b, "latin1"));
    case "hex":
      return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    default:
      throw Object.assign(new Error(`EINVAL: unknown encoding '${String(encoding)}'`), {
        code: "EINVAL",
      });
  }
}
