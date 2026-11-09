/** Dedicated Worker: compiles the binaries from bytes, runs the X1e checks or benches. */
import type { Fixtures } from "../../05-runtime-matrix/src/types.js";
import { runWasmBench, runWasmConformance } from "../src/conformance.js";
import { compileModulesFromBytes } from "../src/load-from-bytes.js";

self.onmessage = async (e: MessageEvent<{ fixtures?: Fixtures; benchAll?: string[] }>) => {
  try {
    const modules = await compileModulesFromBytes();
    if (e.data.fixtures)
      self.postMessage({ checks: await runWasmConformance(e.data.fixtures, modules) });
    else if (e.data.benchAll) {
      const rows = [];
      for (const name of e.data.benchAll) {
        await runWasmBench(name, modules);
        rows.push(await runWasmBench(name, modules));
      }
      self.postMessage({ rows });
    }
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
