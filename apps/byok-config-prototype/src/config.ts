/**
 * The prototype's configuration document — pure, DOM-free, dependency-free.
 *
 * This is the part of the prototype worth keeping: it is the answer to
 * "what does a BYOK-shaped LLM connections config file look like, and what
 * operations does the UI need against it?". The React shell around it is
 * throwaway.
 *
 * Shape, mirroring the OpenRouter BYOK screens:
 *
 *   config
 *     └ providers[<providerId>]
 *         ├ prioritized: ProviderKey[]   // attempted in order, first
 *         └ fallback:    ProviderKey[]   // attempted only after the defaults
 *
 * A key's `models` / `clientKeys` filters are the FILTERS section of a key card.
 */

/** A filter over a set of ids: either everything, or an explicit allow-list. */
export type Filter = { mode: "all" } | { mode: "specific"; ids: string[] };

/** One credential entry inside a provider's prioritized/fallback section. */
export interface ProviderKey {
  id: string;
  /** Optional display name ("Production", "Team A", …). */
  name: string;
  /** The provider credential. Stored in the file — see the prototype warning. */
  apiKey: string;
  /** Never fall back to the built-in endpoints for this provider. */
  alwaysUse: boolean;
  /** Restrict this key to specific models. */
  models: Filter;
  /** Restrict this key to specific client API keys declared in `clientKeys`. */
  clientKeys: Filter;
}

export type Tier = "prioritized" | "fallback";

export interface ProviderConfig {
  prioritized: ProviderKey[];
  fallback: ProviderKey[];
}

export interface ConnectionsConfig {
  schema: "statewalker.llm-connections";
  version: 1;
  /** Client-side API keys that may be granted access to a provider key. */
  clientKeys: Array<{ id: string; name: string }>;
  providers: Record<string, ProviderConfig>;
}

export const CONFIG_SCHEMA = "statewalker.llm-connections";
export const CONFIG_VERSION = 1;

export function emptyConfig(): ConnectionsConfig {
  return { schema: CONFIG_SCHEMA, version: CONFIG_VERSION, clientKeys: [], providers: {} };
}

/**
 * Key id. `crypto.randomUUID()` is deliberately avoided: it is gated on a
 * secure context, so it throws when the app is served over plain http on a LAN
 * address. `getRandomValues` is not gated.
 */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `key_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function newKey(): ProviderKey {
  return {
    id: newId(),
    name: "",
    apiKey: "",
    alwaysUse: false,
    models: { mode: "all" },
    clientKeys: { mode: "all" },
  };
}

// ── Reading ──────────────────────────────────────────────────────────────

/**
 * Tolerant parse: anything unrecognised is dropped and reported as a warning,
 * so pointing the app at an unrelated (or empty, or hand-edited) JSON file
 * yields a usable config instead of an error screen.
 */
export function parseConfig(text: string): { config: ConnectionsConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config = emptyConfig();

  let raw: unknown;
  try {
    raw = text.trim() === "" ? {} : JSON.parse(text);
  } catch (err) {
    return { config, warnings: [`Not valid JSON (${(err as Error).message}) — starting empty.`] };
  }
  if (!isRecord(raw)) return { config, warnings: ["Top level is not an object — starting empty."] };

  if (raw.schema !== undefined && raw.schema !== CONFIG_SCHEMA) {
    warnings.push(`Unexpected schema "${String(raw.schema)}" — reading it anyway.`);
  }
  if (typeof raw.version === "number" && raw.version !== CONFIG_VERSION) {
    warnings.push(`Config version ${raw.version} ≠ ${CONFIG_VERSION} — reading it anyway.`);
  }

  if (raw.clientKeys !== undefined && !Array.isArray(raw.clientKeys)) {
    warnings.push("clientKeys is not an array — dropped.");
  } else if (Array.isArray(raw.clientKeys)) {
    for (const entry of raw.clientKeys) {
      if (isRecord(entry) && typeof entry.id === "string") {
        config.clientKeys.push({ id: entry.id, name: str(entry.name) || entry.id });
      }
    }
  }

  if (raw.providers !== undefined && !isRecord(raw.providers)) {
    warnings.push("providers is not an object — dropped.");
  } else if (isRecord(raw.providers)) {
    for (const [providerId, value] of Object.entries(raw.providers)) {
      if (!isRecord(value)) {
        warnings.push(`providers.${providerId} is not an object — skipped.`);
        continue;
      }
      config.providers[providerId] = {
        prioritized: parseKeys(value.prioritized, `${providerId}.prioritized`, warnings),
        fallback: parseKeys(value.fallback, `${providerId}.fallback`, warnings),
      };
    }
  }

  return { config, warnings };
}

function parseKeys(value: unknown, where: string, warnings: string[]): ProviderKey[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${where} is not an array — skipped.`);
    return [];
  }
  return value.filter(isRecord).map((entry) => ({
    id: str(entry.id) || newId(),
    name: str(entry.name),
    apiKey: str(entry.apiKey),
    alwaysUse: entry.alwaysUse === true,
    models: parseFilter(entry.models),
    clientKeys: parseFilter(entry.clientKeys),
  }));
}

function parseFilter(value: unknown): Filter {
  if (isRecord(value) && value.mode === "specific") {
    const ids = Array.isArray(value.ids) ? value.ids.filter((id) => typeof id === "string") : [];
    return { mode: "specific", ids: ids as string[] };
  }
  return { mode: "all" };
}

// ── Writing ──────────────────────────────────────────────────────────────

/**
 * A key is only "configured" once it carries a credential. Half-filled cards —
 * an "+ Add key" that was never filled in, or a name typed with no key pasted —
 * exist in the editing session but are never written to the file and never
 * counted on the providers list.
 */
export function isConfigured(key: ProviderKey): boolean {
  return key.apiKey.trim() !== "";
}

/** Serialise for disk. Unconfigured keys, and then empty providers, are dropped. */
export function serializeConfig(config: ConnectionsConfig): string {
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, provider] of Object.entries(config.providers)) {
    const kept = {
      prioritized: provider.prioritized.filter(isConfigured),
      fallback: provider.fallback.filter(isConfigured),
    };
    if (kept.prioritized.length + kept.fallback.length > 0) providers[id] = kept;
  }
  return `${JSON.stringify({ ...config, providers }, null, 2)}\n`;
}

// ── Operations the UI performs ───────────────────────────────────────────

export function providerOf(config: ConnectionsConfig, providerId: string): ProviderConfig {
  return config.providers[providerId] ?? { prioritized: [], fallback: [] };
}

/** Configured keys only — a blank card must not make a provider look set up. */
export function keyCount(config: ConnectionsConfig, providerId: string): number {
  const provider = providerOf(config, providerId);
  return [...provider.prioritized, ...provider.fallback].filter(isConfigured).length;
}

function withProvider(
  config: ConnectionsConfig,
  providerId: string,
  edit: (provider: ProviderConfig) => ProviderConfig,
): ConnectionsConfig {
  return {
    ...config,
    providers: { ...config.providers, [providerId]: edit(providerOf(config, providerId)) },
  };
}

export function addKey(
  config: ConnectionsConfig,
  providerId: string,
  tier: Tier,
  key: ProviderKey = newKey(),
): ConnectionsConfig {
  return withProvider(config, providerId, (p) => ({ ...p, [tier]: [...p[tier], key] }));
}

export function updateKey(
  config: ConnectionsConfig,
  providerId: string,
  keyId: string,
  patch: Partial<ProviderKey>,
): ConnectionsConfig {
  return withProvider(config, providerId, (p) => ({
    prioritized: p.prioritized.map((k) => (k.id === keyId ? { ...k, ...patch } : k)),
    fallback: p.fallback.map((k) => (k.id === keyId ? { ...k, ...patch } : k)),
  }));
}

export function removeKey(
  config: ConnectionsConfig,
  providerId: string,
  keyId: string,
): ConnectionsConfig {
  return withProvider(config, providerId, (p) => ({
    prioritized: p.prioritized.filter((k) => k.id !== keyId),
    fallback: p.fallback.filter((k) => k.id !== keyId),
  }));
}

/** "Drag a key … to move it between sections", without the dragging. */
export function moveKey(
  config: ConnectionsConfig,
  providerId: string,
  keyId: string,
  to: Tier,
): ConnectionsConfig {
  const provider = providerOf(config, providerId);
  const key = [...provider.prioritized, ...provider.fallback].find((k) => k.id === keyId);
  if (!key) return config;
  return addKey(removeKey(config, providerId, keyId), providerId, to, key);
}

/** Toggle one id inside a `specific` filter; a no-op while the filter is `all`. */
export function toggleFilterId(filter: Filter, id: string): Filter {
  if (filter.mode === "all") return filter;
  const ids = filter.ids.includes(id)
    ? filter.ids.filter((existing) => existing !== id)
    : [...filter.ids, id];
  return { mode: "specific", ids };
}

// ── helpers ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
