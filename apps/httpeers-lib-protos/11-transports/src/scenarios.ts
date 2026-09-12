/**
 * The scenarios, written once and run against every transport.
 *
 * A caller is just `(request) => Promise<Response>` — which is what each rung
 * produces. If a scenario passes on one rung and fails on another, the
 * difference is the transport and nothing else, because this file cannot see
 * which rung it is running on.
 */

export type Caller = (request: Request) => Promise<Response>;

export interface Outcome {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ScenarioInit {
  /** A token this site should accept, minted by the test's hub key. */
  goodToken: string;
  /** A token from a DIFFERENT mesh, which must be refused cryptographically. */
  foreignToken: string;
}

const BASE = "http://peer.local";

export async function runScenarios(call: Caller, init: ScenarioInit): Promise<Outcome[]> {
  const out: Outcome[] = [];
  const check = (name: string, pass: boolean, detail: string): void => {
    out.push({ name, pass, detail });
  };

  // 1 — the plainest possible request.
  {
    const res = await call(new Request(`${BASE}/hello`));
    const text = await res.text();
    check(
      "GET /hello → 200",
      res.status === 200 && text === "hello from the mesh",
      `${res.status} ${text}`,
    );
  }

  // 2 — a body, echoed. Proves request AND response bodies survive the rung.
  {
    const res = await call(
      new Request(`${BASE}/echo`, {
        method: "POST",
        body: "round trip",
        headers: { "content-type": "text/plain" },
      }),
    );
    const text = await res.text();
    check(
      "POST /echo round-trips a body",
      res.status === 200 && text === "round trip",
      `${res.status} ${text}`,
    );
  }

  // 3 — a large body, to catch a rung that chunks or truncates.
  {
    const payload = "x".repeat(256 * 1024);
    const res = await call(new Request(`${BASE}/echo`, { method: "POST", body: payload }));
    const text = await res.text();
    check(
      "POST /echo survives 256 KiB",
      res.status === 200 && text.length === payload.length,
      `${res.status} got ${text.length} of ${payload.length}`,
    );
  }

  // 4 — no credential: refused, and refused the same way everywhere.
  {
    const res = await call(new Request(`${BASE}/secret`));
    check("GET /secret without a token → 401", res.status === 401, String(res.status));
  }

  // 5 — THE ONE THAT MATTERS FOR THE DIRECTIVE. A Biscuit token in a header,
  // verified by the site. On rungs 1 and 2 there is no libp2p in the process,
  // so this passing IS the proof that validation needs none.
  {
    const res = await call(
      new Request(`${BASE}/secret`, { headers: { authorization: `Bearer ${init.goodToken}` } }),
    );
    const body = res.status === 200 ? ((await res.json()) as { roles?: string[] }) : null;
    check(
      "GET /secret with a valid token → 200 (no libp2p needed)",
      res.status === 200 && body?.roles?.includes("member") === true,
      `${res.status} ${JSON.stringify(body)}`,
    );
  }

  // 6 — a token from another mesh fails, and fails as a refusal rather than
  // as a 500 or a hang.
  {
    const res = await call(
      new Request(`${BASE}/secret`, { headers: { authorization: `Bearer ${init.foreignToken}` } }),
    );
    check("GET /secret with a foreign mesh's token → 403", res.status === 403, String(res.status));
  }

  // 7 — an unrouted path is a 404 from the site, not a transport error.
  {
    const res = await call(new Request(`${BASE}/nothing-here`));
    check("GET /nothing-here → 404", res.status === 404, String(res.status));
  }

  // 8 — the query string survives. This was a real defect in the stock
  // libp2p HTTP adapter, and it was SILENT: the call succeeded and the
  // parameters vanished.
  {
    const res = await call(new Request(`${BASE}/hello?who=me&n=2`));
    check("a query string is not lost", res.status === 200, String(res.status));
  }

  return out;
}
