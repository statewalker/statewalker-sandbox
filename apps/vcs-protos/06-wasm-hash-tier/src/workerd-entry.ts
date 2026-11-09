/** workerd: the binaries are imported precompiled (CompiledWasm modules), never compiled from bytes. */
import type { Fixtures } from "../../05-runtime-matrix/src/types.js";
import { runWasmBench, runWasmConformance } from "./conformance.js";
import { BLAKE3_WASM_B64 } from "./wasm/binaries.js";
import blake3 from "./wasm/blake3.wasm";
import sha1 from "./wasm/sha1.wasm";
import sha256 from "./wasm/sha256.wasm";
import { base64ToBytes } from "./wasm-hasher.js";
import {
  runDigestStreamBench,
  runDigestStreamConformance,
  WORKERD_NATIVE_BENCH_NAMES,
} from "./workerd-native.js";

const modules = { blake3, sha1, sha256 };

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/conformance") {
      return Response.json(await runWasmConformance((await req.json()) as Fixtures, modules));
    }
    if (url.pathname === "/digeststream") {
      return Response.json(await runDigestStreamConformance((await req.json()) as Fixtures));
    }
    if (url.pathname.startsWith("/bench/")) {
      const name = url.pathname.slice("/bench/".length);
      if ((WORKERD_NATIVE_BENCH_NAMES as readonly string[]).includes(name)) {
        return Response.json(await runDigestStreamBench(name));
      }
      return Response.json(await runWasmBench(name, modules));
    }
    if (url.pathname === "/compile-from-bytes") {
      // The trap R6 documents: what hash-wasm and similar libraries do at runtime.
      try {
        await WebAssembly.compile(base64ToBytes(BLAKE3_WASM_B64) as Uint8Array<ArrayBuffer>);
        return new Response("compiled");
      } catch (e) {
        return new Response(`refused: ${String(e)}`);
      }
    }
    return new Response("noop");
  },
};
