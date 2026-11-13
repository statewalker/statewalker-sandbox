// The patches to @statewalker/cellb 0.8.7 that Kitesurf needs, applied to an unpacked copy of the
// package. `patches/@statewalker__cellb@0.8.7.patch` (pnpm `patchedDependencies`) is its output,
// made from a pristine copy (pnpm's own `pnpm patch` directory already has the patch applied):
//
//   npm pack @statewalker/cellb@0.8.7 && mkdir a b
//   tar xzf statewalker-cellb-0.8.7.tgz -C a --strip-components=1
//   tar xzf statewalker-cellb-0.8.7.tgz -C b --strip-components=1
//   node scripts/patch-cellb.mjs b
//   git diff --no-index --no-prefix a b > ../../patches/@statewalker__cellb@0.8.7.patch
//
// Idempotent. Each patch is a difference between CellB and workerd that Kitesurf runs into.
//
// 1. Worker Loader `{ cjs }` modules. workerd supports them; CellB turns them into
//    `export default undefined`. Kitesurf loads page scripts and web workers as cjs modules.
// 2. CompiledWasm imports compile synchronously. CellB emits `export default await
//    WebAssembly.compile(...)`; that top-level await makes every importer async, and with
//    Kitesurf's circular imports esbuild's async module inits wait on each other forever
//    (loadProject never settles). workerd imports wasm modules synchronously.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error("usage: node scripts/patch-cellb.mjs <unpacked @statewalker/cellb directory>");
  process.exit(1);
}
const dist = `${join(pkgDir, "dist")}/`;

function patch(rel, marker, anchor, replacement) {
  const file = dist + rel;
  const src = readFileSync(file, "utf8");
  if (src.includes(marker)) return console.log(`cellb patch ${marker}: already applied`);
  if (!src.includes(anchor)) throw new Error(`cellb patch ${marker}: anchor not found in ${file}`);
  writeFileSync(file, src.replace(anchor, replacement));
  console.log(`cellb patch ${marker}: applied`);
}

patch(
  "bindings/worker-loader.js",
  "/* cjs-patch */",
  "    return m.js ?? m.esModule ??",
  `    /* cjs-patch */ if (typeof m.cjs === "string") return "const module = { exports: {} }; " +
        "(function (module, exports) {\\n" + m.cjs + "\\n})(module, module.exports);\\n" +
        "export default module.exports;";
    return m.js ?? m.esModule ??`,
);

patch(
  "project/module-rules.js",
  "/* sync-wasm-patch */",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: CellB's source text, a template literal
  "`export default await WebAssembly.compile(bytes(${b64}));`",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: CellB's source text, a template literal
  "`/* sync-wasm-patch */ export default new WebAssembly.Module(bytes(${b64}));`",
);

// 3. Static assets with a class default export. CellB checks `module.default.fetch`, which a
//    `WorkerEntrypoint` subclass (Kitesurf's `export default KitesurfEngine`) only has on its
//    prototype, so every request missing the assets got CellB's "Not found" instead of the Worker.
patch(
  "project/wrangler.js",
  "/* class-default-patch */",
  'const hasWorker = typeof module.default?.fetch === "function";',
  'const hasWorker = /* class-default-patch */ typeof (module.default?.fetch ?? module.default?.prototype?.fetch) === "function";',
);

// 4. A class default export (`export default class extends WorkerEntrypoint`) as the Worker's
//    fetch handler: workerd makes an instance per request with (ctx, env). CellB only calls
//    `default.fetch`, so it answered "Worker has no fetch handler".
patch(
  "core/runtime.js",
  "/* class-entrypoint-patch */",
  "            const handler = opts.worker.default?.fetch;",
  `            /* class-entrypoint-patch */ const D = opts.worker.default;
            const handler = typeof D === "function" && typeof D.prototype?.fetch === "function"
                ? (req, env, ctx) => new D({ ...ctx, props: {} }, env).fetch(req)
                : D?.fetch;`,
);

// 5. `abortIsolate` of `cloudflare:workers` (workerd's experimental isolate kill). Kitesurf's page,
//    renderer and web-worker isolates import it, so their build failed. CellB cannot kill an
//    isolate from inside, so the call throws, as it never returns on workerd either; the isolate
//    stays until the loaded Worker is released.
patch(
  "project/cloudflare-workers.js",
  "/* abort-isolate-patch */",
  'export { RpcTarget } from "../core/durable-object.js";',
  `export { RpcTarget } from "../core/durable-object.js";
/* abort-isolate-patch */ export function abortIsolate(reason) {
    throw reason instanceof Error ? reason : new Error(String(reason ?? "isolate aborted"));
}`,
);

// 6. A writable `navigator` in Node isolate threads. Node's `navigator` global is a getter only;
//    in workerd (and a browser Dedicated Worker's realm, for code that redefines it) Worker code
//    may assign it. Kitesurf's DOM shim does `globalThis.navigator = ...`.
patch(
  "isolate/node-entry.js",
  "/* writable-navigator-patch */",
  "Object.assign(globalThis, {\n    Request: CellsRequest,",
  `/* writable-navigator-patch */ Object.defineProperty(globalThis, "navigator", {
    value: globalThis.navigator, writable: true, configurable: true, enumerable: true,
});
Object.assign(globalThis, {
    Request: CellsRequest,`,
);

// 7. `stub.dup()` on stubs that cross into a loaded Worker's isolate. On workerd it returns a
//    copy that outlives the call. CellB's stub proxy made every property a remote method, so
//    `dup()` became a remote call whose RpcPromise is not callable. Kitesurf dups the outbound and
//    upstream callbacks of openSession, so page fetches (fonts, subresources) failed with "o is
//    not a function". CellB stubs do not expire when the call returns, so dup returns the stub.
patch(
  "isolate/protocol.js",
  "/* stub-dup-patch */",
  `                if (prop === "then" || typeof prop === "symbol")
                    return undefined;
                return (...args) => invoke([prop], args);`,
  `                if (prop === "then" || typeof prop === "symbol")
                    return undefined;
                /* stub-dup-patch */ if (prop === "dup")
                    return () => stub;
                return (...args) => invoke([prop], args);`,
);

// 8. Request, Response, Headers and ReadableStream values in RPC arguments and results that cross
//    into or out of a loaded Worker's isolate. workerd's RPC carries them; CellB structured-clones
//    every message, which throws DataCloneError for them. Kitesurf's outbound callback takes a
//    request description with Headers and returns a Response (page subresources, fonts).
//    They cross as plain markers here, with bodies buffered (no streaming), and are rebuilt.
const WIRE = `/* wire-types-patch */
const isA = (v, name) => {
    const C = globalThis[name];
    return typeof C === "function" && v instanceof C;
};
const wireKind = (v) => !v || typeof v !== "object" ? undefined
    : isA(v, "Response") ? "response" : isA(v, "Request") ? "request"
    : isA(v, "Headers") ? "headers" : isA(v, "ReadableStream") ? "stream" : undefined;
function needsWire(v, depth = 0) {
    if (!v || typeof v !== "object" || depth > 32) return false;
    if (wireKind(v)) return true;
    if (Array.isArray(v)) return v.some((x) => needsWire(x, depth + 1));
    if (Object.getPrototypeOf(v) !== Object.prototype) return false;
    return Object.values(v).some((x) => needsWire(x, depth + 1));
}
async function toWire(v) {
    switch (wireKind(v)) {
        case "headers": return { __cellbWire: "headers", entries: [...v] };
        case "stream": return { __cellbWire: "stream", body: await new Response(v).arrayBuffer() };
        case "response": return { __cellbWire: "response", status: v.status, statusText: v.statusText,
            url: v.url, headers: [...v.headers], body: v.body ? await v.arrayBuffer() : null };
        case "request": return { __cellbWire: "request", url: v.url, method: v.method,
            headers: [...v.headers], redirect: v.redirect,
            body: v.body && v.method !== "GET" && v.method !== "HEAD" ? await v.arrayBuffer() : null };
    }
    if (Array.isArray(v)) return Promise.all(v.map((x) => needsWire(x) ? toWire(x) : x));
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
        const out = {};
        for (const [k, x] of Object.entries(v)) out[k] = needsWire(x) ? await toWire(x) : x;
        return out;
    }
    return v;
}
const toWireMaybe = (v) => (needsWire(v) ? toWire(v) : v);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
function fromWire(v) {
    switch (v.__cellbWire) {
        case "headers": return new Headers(v.entries);
        case "stream": return new Response(v.body).body;
        case "response": {
            const r = new Response(NULL_BODY.has(v.status) ? null : v.body,
                { status: v.status, statusText: v.statusText, headers: v.headers });
            if (v.url) Object.defineProperty(r, "url", { value: v.url });
            return r;
        }
        case "request": return new Request(v.url, { method: v.method, headers: v.headers,
            redirect: v.redirect, body: v.body });
    }
    return undefined;
}
function callsOver(port, handle) {`;
patch("isolate/protocol.js", "/* wire-types-patch */", "function callsOver(port, handle) {", WIRE);
patch(
  "isolate/protocol.js",
  "/* wire-decode-patch */",
  `            if (typeof v[REF] === "number")
                return stubOf(v[REF]);`,
  `            /* wire-decode-patch */ if (typeof v.__cellbWire === "string")
                return fromWire(v);
            if (typeof v[REF] === "number")
                return stubOf(v[REF]);`,
);
patch(
  "isolate/protocol.js",
  "/* wire-send-patch */",
  "listenPort(port, (msg) => serve(decode(msg)).then(encode).catch(throwOwn));",
  "listenPort(port, (msg) => serve(decode(msg)).then(toWireMaybe).then(encode).catch(throwOwn)); /* wire-send-patch */",
);
patch(
  "isolate/protocol.js",
  "/* wire-call-patch */",
  "const result = (async () => decode(await callPort(port, encode({ ...msg, answer }), { timeout: NO_TIMEOUT })))();",
  "const result = (async () => decode(await callPort(port, encode(await toWireMaybe({ ...msg, answer })), { timeout: NO_TIMEOUT })))(); /* wire-call-patch */",
);

// 9. Uint8Array toBase64/fromBase64/toHex/fromHex in isolate threads (workerd has them, Node 22
//    does not). Kitesurf encodes screenshots with toBase64. The host's main thread loads the same
//    polyfill from ../polyfills.mjs.
const polyfill = readFileSync(new URL("../polyfills.mjs", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => !l.startsWith("//"))
  .join("\n");
patch(
  "isolate/node-entry.js",
  "/* polyfills-patch */",
  'import { parentPort } from "node:worker_threads";',
  `import { parentPort } from "node:worker_threads";
/* polyfills-patch */
${polyfill}`,
);
