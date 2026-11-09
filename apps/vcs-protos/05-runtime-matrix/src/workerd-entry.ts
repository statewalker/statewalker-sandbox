/** workerd module worker: POST /conformance with fixtures; GET /bench/<name>; anything else is a no-op. */
import { runBench, runConformance } from "./conformance.js";
import type { Fixtures } from "./types.js";

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/conformance") {
      return Response.json(await runConformance((await req.json()) as Fixtures));
    }
    if (url.pathname.startsWith("/bench/")) {
      return Response.json(await runBench(url.pathname.slice("/bench/".length)));
    }
    return new Response("noop");
  },
};
