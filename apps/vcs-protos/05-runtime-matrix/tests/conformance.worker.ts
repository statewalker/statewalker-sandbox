/** Dedicated Worker: receives fixtures (or a bench name), replies with results. */
import { runBench, runConformance } from "../src/conformance.js";
import type { Fixtures } from "../src/types.js";

self.onmessage = async (e: MessageEvent<{ fixtures?: Fixtures; bench?: string }>) => {
  try {
    if (e.data.fixtures) self.postMessage({ checks: await runConformance(e.data.fixtures) });
    else if (e.data.bench) self.postMessage({ row: await runBench(e.data.bench) });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
