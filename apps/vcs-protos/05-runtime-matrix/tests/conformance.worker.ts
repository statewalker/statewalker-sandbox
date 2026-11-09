/** Dedicated Worker: receives fixtures (or bench names), replies with results. */
import { runBench, runConformance } from "../src/conformance.js";
import type { Fixtures } from "../src/types.js";

self.onmessage = async (e: MessageEvent<{ fixtures?: Fixtures; benchAll?: string[] }>) => {
  try {
    if (e.data.fixtures) self.postMessage({ checks: await runConformance(e.data.fixtures) });
    else if (e.data.benchAll) {
      const rows = [];
      for (const name of e.data.benchAll) {
        await runBench(name); // warm-up in this same worker
        rows.push(await runBench(name));
      }
      self.postMessage({ rows });
    }
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
