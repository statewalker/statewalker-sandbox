// Uint8Array base64/hex methods (TC39, shipped in workerd's V8) for Node versions without them.
// Loaded in the main thread by server.mjs and in every isolate thread (patch-cellb.mjs, patch 9).
if (typeof Uint8Array.prototype.toBase64 !== "function") {
  const toB64 = (bytes, opts = {}) => {
    let s = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      opts.alphabet === "base64url" ? "base64url" : "base64",
    );
    if (opts.alphabet === "base64url" && !opts.omitPadding)
      s += "=".repeat((4 - (s.length % 4)) % 4);
    if (opts.alphabet !== "base64url" && opts.omitPadding) s = s.replace(/=+$/, "");
    return s;
  };
  Object.defineProperties(Uint8Array.prototype, {
    toBase64: {
      value(opts) {
        return toB64(this, opts);
      },
      writable: true,
      configurable: true,
    },
    toHex: {
      value() {
        return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString("hex");
      },
      writable: true,
      configurable: true,
    },
  });
  Object.defineProperties(Uint8Array, {
    fromBase64: {
      value(s, opts = {}) {
        return new Uint8Array(
          Buffer.from(s, opts.alphabet === "base64url" ? "base64url" : "base64"),
        );
      },
      writable: true,
      configurable: true,
    },
    fromHex: {
      value(s) {
        if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new SyntaxError("invalid hex string");
        return new Uint8Array(Buffer.from(s, "hex"));
      },
      writable: true,
      configurable: true,
    },
  });
}
