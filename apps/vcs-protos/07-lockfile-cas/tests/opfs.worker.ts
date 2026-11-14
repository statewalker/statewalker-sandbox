/** Dedicated Worker contender for R6: one casRef on a shared OPFS directory. */
import { opfsAtomicFiles } from "../src/adapters/opfs.js";
import { casRef } from "../src/lockfile.js";

self.onmessage = async (
  e: MessageEvent<{ dir: string; expected: string; next: string; startAt: number }>,
) => {
  try {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(e.data.dir, {
      create: true,
    });
    while (Date.now() < e.data.startAt) {
      await new Promise((r) => setTimeout(r, 1));
    }
    self.postMessage({
      result: await casRef(opfsAtomicFiles(root), "refs/heads/main", e.data.expected, e.data.next),
    });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
