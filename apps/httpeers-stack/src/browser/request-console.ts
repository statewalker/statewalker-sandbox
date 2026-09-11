/**
 * The request console, shared by every page that has one.
 *
 * The proxy page and the app page both send a request and show what comes
 * back. What differs is only the TRANSPORT: the proxy page hands the `Request`
 * straight to its own endpoint, while the app page sends it through the mesh
 * to another peer. Keeping rendering here and transport with the caller is
 * what makes that difference visible instead of buried -- the same request, the
 * same display, two paths.
 *
 * THE BODY IS NEVER COLLECTED. `streamInto` reads chunk by chunk and reports
 * each one as it lands. A console that called `.text()` would show a correct
 * answer for a streaming upstream and a buffering one alike, which is exactly
 * the difference this exists to expose.
 */

/** One `Name: value` per line. Only the FIRST colon separates, so URL-valued headers survive. */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    if (name === "") continue;
    headers[name] = line.slice(at + 1).trim();
  }
  return headers;
}

/**
 * The status line for a response.
 *
 * The proxy's OWN answers carry `x-httpeers-proxy`, and it is shown whenever
 * present: a 404 the proxy produced (no such route) and a 404 the upstream
 * sent (no such resource) need different fixes, and look identical otherwise.
 */
export function describeStatus(res: Response): string {
  const parts = [`${res.status}${res.statusText ? ` ${res.statusText}` : ""}`];
  const type = res.headers.get("content-type");
  if (type) parts.push(type);
  const marker = res.headers.get("x-httpeers-proxy");
  if (marker) parts.push(`x-httpeers-proxy: ${marker}`);
  return parts.join(" · ");
}

export interface StreamStats {
  chunks: number;
  /** Time from the call to the first chunk, or `null` if none arrived. */
  firstChunkMs: number | null;
  totalMs: number;
}

/**
 * Read `res.body` chunk by chunk, handing each decoded piece to `onText`.
 *
 * Returns timing because timing is the evidence: streaming keeps first-chunk
 * and total apart, and anything that buffered on the way collapses them
 * together. Chunk count alone would not tell a streamed response from a
 * buffered one delivered in pieces.
 */
export async function streamInto(res: Response, onText: (text: string) => void): Promise<StreamStats> {
  const t0 = performance.now();
  const reader = res.body?.getReader();
  if (reader == null) return { chunks: 0, firstChunkMs: null, totalMs: performance.now() - t0 };

  const decoder = new TextDecoder();
  let chunks = 0;
  let firstChunkMs: number | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstChunkMs === null) firstChunkMs = performance.now() - t0;
    chunks += 1;
    onText(decoder.decode(value, { stream: true }));
  }
  const tail = decoder.decode();
  if (tail !== "") onText(tail);
  return { chunks, firstChunkMs, totalMs: performance.now() - t0 };
}

/** A ready-made request, so a console does something before anyone types. */
export interface ConsoleExample {
  label: string;
  method: string;
  /** Path relative to the proxy mount: `/swapi/people/1/`. */
  path: string;
}

/**
 * Requests against `DEFAULT_ROUTES`, each proving something different.
 *
 * None of them is the bare `/swapi`: that maps to `https://swapi.dev/api`,
 * which answers 403 while `/api/` answers 200 -- swapi's rule, but it would
 * make the first click look like a broken proxy.
 */
export const DEFAULT_EXAMPLES: readonly ConsoleExample[] = [
  { label: "swapi · Luke", method: "GET", path: "/swapi/people/1/" },
  { label: "swapi · Tatooine", method: "GET", path: "/swapi/planets/1/" },
  { label: "httpbin · headers", method: "GET", path: "/httpbin/headers" },
  { label: "httpbin · drip (streaming)", method: "GET", path: "/httpbin/drip?duration=3&numbytes=6&delay=0" },
];

/** Buttons that fill a console's method and path fields. Returns the container. */
export function renderExamples(
  examples: readonly ConsoleExample[],
  fill: (example: ConsoleExample) => void,
): HTMLElement {
  const row = document.createElement("p");
  row.className = "examples";
  row.append("try: ");
  for (const example of examples) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = example.label;
    button.addEventListener("click", () => fill(example));
    row.append(button);
  }
  return row;
}
