/**
 * Static provider + model catalog — the *seed* list shown before a key has been
 * tested. Pressing "Test" calls the provider's live model-list endpoint and
 * replaces these entries with the real ones for the rest of the session, so
 * treat everything here as a placeholder, not as fact.
 */

import type { TestEndpoint } from "./test-connection.js";

export interface CatalogModel {
  id: string;
  label: string;
  /** Release group heading in the model picker, newest first. */
  group: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** Two-letter mark used in place of the provider logo. */
  mark: string;
  /** Tailwind classes for the mark tile. */
  markClass: string;
  keyPlaceholder: string;
  docsUrl: string;
  models: CatalogModel[];
  /** Live model-list endpoint used by "Test"; `null` when not reachable from a browser. */
  test: TestEndpoint | null;
  /** Shown in place of the Test button when `test` is `null`. */
  untestable?: string;
}

export const PROVIDERS: CatalogProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    mark: "A\\",
    markClass: "bg-[#d4a27f] text-[#2b1a10]",
    keyPlaceholder: "sk-ant-…",
    docsUrl: "https://docs.claude.com/en/docs/about-claude/models/overview",
    test: { style: "anthropic", url: "https://api.anthropic.com/v1/models?limit=100" },
    models: [
      { id: "claude-opus-5", label: "Claude Opus 5", group: "July 2026" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", group: "June 2026" },
      { id: "claude-fable-5", label: "Claude Fable 5", group: "June 2026" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", group: "October 2025" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    mark: "OA",
    markClass: "bg-[#10a37f] text-white",
    keyPlaceholder: "sk-…",
    docsUrl: "https://platform.openai.com/docs/models",
    test: { style: "openai", url: "https://api.openai.com/v1/models" },
    models: [{ id: "gpt-4o", label: "GPT-4o", group: "Models" }],
  },
  {
    id: "google",
    name: "Google AI Studio",
    mark: "G",
    markClass: "bg-[#1a73e8] text-white",
    keyPlaceholder: "AIza…",
    docsUrl: "https://ai.google.dev/gemini-api/docs/models",
    test: {
      style: "google",
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    },
    models: [{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", group: "Models" }],
  },
  {
    id: "mistral",
    name: "Mistral",
    mark: "M",
    markClass: "bg-[#fa520f] text-white",
    keyPlaceholder: "…",
    docsUrl: "https://docs.mistral.ai/getting-started/models/models_overview/",
    test: { style: "openai", url: "https://api.mistral.ai/v1/models" },
    models: [{ id: "mistral-large-latest", label: "Mistral Large", group: "Models" }],
  },
  {
    id: "groq",
    name: "Groq",
    mark: "GQ",
    markClass: "bg-[#f55036] text-white",
    keyPlaceholder: "gsk_…",
    docsUrl: "https://console.groq.com/docs/models",
    test: { style: "openai", url: "https://api.groq.com/openai/v1/models" },
    models: [],
  },
  {
    id: "together",
    name: "Together AI",
    mark: "TA",
    markClass: "bg-[#0f6fff] text-white",
    keyPlaceholder: "…",
    docsUrl: "https://docs.together.ai/docs/serverless-models",
    test: { style: "openai", url: "https://api.together.xyz/v1/models" },
    models: [],
  },
  {
    id: "fireworks",
    name: "Fireworks",
    mark: "FW",
    markClass: "bg-[#5b21b6] text-white",
    keyPlaceholder: "fw_…",
    docsUrl: "https://fireworks.ai/models",
    test: { style: "openai", url: "https://api.fireworks.ai/inference/v1/models" },
    models: [],
  },
  {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    mark: "AB",
    markClass: "bg-[#232f3e] text-[#ff9900]",
    keyPlaceholder: "AKIA…",
    docsUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html",
    test: null,
    untestable: "Bedrock authenticates with SigV4 request signing, not a bearer key.",
    models: [],
  },
  {
    id: "azure",
    name: "Azure",
    mark: "AZ",
    markClass: "bg-[#0078d4] text-white",
    keyPlaceholder: "…",
    docsUrl: "https://learn.microsoft.com/azure/ai-services/openai/concepts/models",
    test: null,
    untestable: "Azure needs your own resource endpoint and deployment name.",
    models: [],
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible endpoint",
    mark: "{}",
    markClass: "bg-neutral-800 text-white",
    keyPlaceholder: "…",
    docsUrl: "https://platform.openai.com/docs/api-reference",
    test: null,
    untestable: "No base-URL field on a key yet — nothing to call.",
    models: [],
  },
];

export function providerById(id: string): CatalogProvider | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}
