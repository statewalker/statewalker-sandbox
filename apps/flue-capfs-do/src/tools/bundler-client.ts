// The Agent's side of bundling in the deployment: the bundler Worker (src/bundler/program.ts)
// runs in its own Worker Loader isolate, loaded on demand. Its code is embedded (a few hundred
// KB); esbuild.wasm (about 14 MB) is fetched once per isolate from BUNDLER_WASM_URL and must
// match the SHA-256 the code was built for. No URL: bundling is not offered (ENOSYS).
//
// The isolate is kept between calls (esbuild is stateless across builds and runs nothing it is
// given); a call that fails other than by the request, or times out, retires it, and the next
// call loads a fresh one.

import program from "../bundler/program.gen.js";
import {
  BUNDLE_LIMITS,
  type BundleRequest,
  type CheckedBundleRequest,
  checkBundleRequest,
} from "./bundle-request.ts";
import type { ToolBundleConfig } from "./config.ts";

/** The part of the Worker Loader binding used here. */
interface Loader {
  get(
    id: string,
    code: () => Promise<{
      compatibilityDate: string;
      mainModule: string;
      modules: Record<string, string | { wasm: Uint8Array }>;
      env: Record<string, unknown>;
      globalOutbound: null;
    }>,
  ): { getEntrypoint(): unknown };
}

export interface BundlerEnv {
  LOADER?: unknown;
  /** Where esbuild.wasm is (the esbuild-wasm version the bundler was built for). */
  BUNDLER_WASM_URL?: string;
}

export interface BundleResult {
  code: string;
  hash: string;
  check: { ok: boolean; problems: string[] };
}

const TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;
/** esbuild.wasm is about 14 MB; anything far larger is not it. */
const MAX_WASM_BYTES = 32 * 1024 * 1024;
/**
 * A retired isolate cannot be stopped from here (the Worker Loader has no terminate): it runs
 * until its runtime ends it. After this many, this Agent isolate stops offering bundling.
 */
const MAX_RETIRED = 3;

let wasm: Promise<Uint8Array> | undefined;
let generation = 0;
// One build at a time per Agent isolate: esbuild-wasm needs about 100 MB for a build.
let queue: Promise<unknown> = Promise.resolve();

async function fetchWasm(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`EIO: bundler: esbuild.wasm: HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_WASM_BYTES)
    throw new Error("EIO: bundler: esbuild.wasm is too large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_WASM_BYTES) throw new Error("EIO: bundler: esbuild.wasm is too large");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== program.wasmSha256)
    throw new Error(
      `EIO: bundler: esbuild.wasm does not match esbuild-wasm ${program.esbuildVersion} (sha256 ${hex})`,
    );
  return bytes;
}

/** Whether this deployment offers bundling (reported by /api/runtime). */
export const bundlerOffered = (env: BundlerEnv) => !!env.LOADER && !!env.BUNDLER_WASM_URL;

/** Checks the request (limits, build-side keys only), then has the bundler Worker build it. */
export async function bundleInDeployment(
  env: BundlerEnv,
  req: BundleRequest,
  deployment: ToolBundleConfig,
): Promise<BundleResult> {
  const checked: CheckedBundleRequest = checkBundleRequest(req, deployment);
  if (!env.LOADER) throw new Error("ENOSYS: bundling needs a Worker Loader binding (LOADER)");
  const url = env.BUNDLER_WASM_URL;
  if (!url) throw new Error("ENOSYS: this deployment offers no bundling (BUNDLER_WASM_URL)");
  if (generation >= MAX_RETIRED)
    throw new Error("EAGAIN: the bundler failed too often here; try again after a restart");
  const run = queue.then(() => build(env, url, checked));
  queue = run.catch(() => {});
  return run;
}

async function build(env: BundlerEnv, url: string, checked: CheckedBundleRequest) {
  wasm ??= fetchWasm(url).catch((e) => {
    wasm = undefined; // a later call fetches again
    throw e;
  });
  const bytes = await wasm;
  const id = `bundler-${program.wasmSha256.slice(0, 16)}-${generation}`;
  const worker = (env.LOADER as Loader).get(id, async () => ({
    compatibilityDate: "2026-10-01",
    mainModule: "bundler.js",
    modules: { "bundler.js": program.code, "esbuild.wasm": { wasm: bytes } },
    env: {},
    globalOutbound: null,
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = (await Promise.race([
      (
        worker.getEntrypoint() as unknown as { bundle(r: CheckedBundleRequest): Promise<unknown> }
      ).bundle(checked),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`ETIMEDOUT: bundler: no answer in ${TIMEOUT_MS} ms`)),
          TIMEOUT_MS,
        );
      }),
    ])) as BundleResult;
    if (new TextEncoder().encode(out.code).byteLength > BUNDLE_LIMITS.output)
      throw new Error("EINVAL: bundle: the bundle is too large");
    return out;
  } catch (e) {
    // A build error in the sources is the request's; anything else retires the isolate.
    const message = String((e as Error)?.message ?? e);
    if (!/^(Error: )?(EINVAL|Build failed)/.test(message)) generation += 1;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
