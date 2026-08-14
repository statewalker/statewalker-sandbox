/**
 * Live "Test" requests against the providers' model-list endpoints.
 *
 * Deliberately a **list-models** call, not an inference call: it validates the
 * key, the endpoint and the browser's CORS access without spending tokens, and
 * it returns something useful — the provider's real model ids, which the caller
 * feeds back into the FILTERS picker in place of the static catalog.
 *
 * The key travels straight from the form field to the provider over TLS. That is
 * only acceptable because this is a prototype; a real client would proxy.
 */

import type { CatalogModel, CatalogProvider } from "./catalog.js";

export interface TestOutcome {
  ok: boolean;
  /** One line for the UI. */
  message: string;
  ms: number;
  /** Present on success — the provider's live model list. */
  models?: CatalogModel[];
}

export async function testConnection(
  provider: CatalogProvider,
  apiKey: string,
): Promise<TestOutcome> {
  const endpoint = provider.test;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  if (!endpoint) return { ok: false, message: provider.untestable ?? "Not testable.", ms: 0 };

  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      headers: authHeaders(endpoint, apiKey),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // A CORS rejection and a dead network are indistinguishable from JS.
    const failure = err as Error;
    const reason = failure.name === "TimeoutError" ? "timed out" : failure.message;
    return { ok: false, message: `Request failed: ${reason}`, ms: elapsed() };
  }

  const body = await response.text();
  const payload = safeJson(body);

  if (!response.ok) {
    return {
      ok: false,
      message: `${response.status} ${response.statusText} — ${truncate(errorMessage(payload) ?? body)}`,
      ms: elapsed(),
    };
  }

  const models = readModels(endpoint.style, payload);
  return {
    ok: true,
    message: `${models.length} model${models.length === 1 ? "" : "s"}`,
    ms: elapsed(),
    models,
  };
}

// ── per-provider request shapes ──────────────────────────────────────────

export type TestEndpoint =
  | { style: "anthropic"; url: string }
  | { style: "openai"; url: string }
  | { style: "google"; url: string };

function authHeaders(endpoint: TestEndpoint, apiKey: string): Record<string, string> {
  switch (endpoint.style) {
    case "anthropic":
      return {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Anthropic blocks browser-origin calls unless this opt-in is present.
        "anthropic-dangerous-direct-browser-access": "true",
      };
    case "openai":
      return { authorization: `Bearer ${apiKey}` };
    case "google":
      return { "x-goog-api-key": apiKey };
  }
}

function readModels(style: TestEndpoint["style"], payload: unknown): CatalogModel[] {
  // Together AI answers with a bare array where the others wrap it in `data`.
  if (style === "openai" && Array.isArray(payload)) {
    return readOpenAiEntries(payload);
  }
  if (!isRecord(payload)) return [];
  switch (style) {
    case "anthropic":
    case "openai":
      return readOpenAiEntries(Array.isArray(payload.data) ? payload.data : []);
    case "google": {
      const models = Array.isArray(payload.models) ? payload.models : [];
      return models.filter(isRecord).flatMap((entry) => {
        const name = typeof entry.name === "string" ? entry.name : null;
        if (!name) return [];
        const id = name.replace(/^models\//, "");
        const label = typeof entry.displayName === "string" ? entry.displayName : id;
        // Gemini's list carries no release date; group by generation method so
        // the picker still has headings.
        const methods = entry.supportedGenerationMethods;
        const group =
          Array.isArray(methods) && methods.includes("embedContent") ? "Embeddings" : "Models";
        return [{ id, label, group }];
      });
    }
  }
}

/**
 * Anthropic and every OpenAI-compatible list share this entry shape. Sorted
 * newest-first so the picker's date headings descend the way the guide's does —
 * providers return their list in no particular order (OpenAI's 124 entries
 * arrive interleaved across four years).
 */
function readOpenAiEntries(entries: unknown[]): CatalogModel[] {
  return entries
    .filter(isRecord)
    .flatMap((entry) => {
      const id = typeof entry.id === "string" ? entry.id : null;
      if (!id) return [];
      const label = typeof entry.display_name === "string" ? entry.display_name : id;
      const at = timestamp(entry.created_at ?? entry.created);
      return [{ id, label, group: monthGroup(entry.created_at ?? entry.created), at }];
    })
    .sort((a, b) => b.at - a.at)
    .map(({ id, label, group }) => ({ id, label, group }));
}

// ── helpers ──────────────────────────────────────────────────────────────

/** ISO string or unix-seconds → epoch ms; unusable values sort last. */
function timestamp(value: unknown): number {
  const date =
    typeof value === "string"
      ? new Date(value)
      : typeof value === "number"
        ? new Date(value * 1000)
        : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
}

/** ISO string or unix-seconds → "July 2026"; anything else → "Models". */
function monthGroup(value: unknown): string {
  const at = timestamp(value);
  if (at === 0) return "Models";
  return new Date(at).toLocaleString("en", { month: "long", year: "numeric" });
}

function errorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const error = payload.error;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed || "no response body";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
