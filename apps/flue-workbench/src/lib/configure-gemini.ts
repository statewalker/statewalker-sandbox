import { configureProvider } from "@flue/runtime/app";

/**
 * Canonical pi-ai provider id for Gemini. Used in model strings as
 * `google/gemini-2.5-flash`, `google/gemini-2.5-pro`, etc.
 *
 * pi-ai (@earendil-works/pi-ai@^0.75) ships a native `./google` provider
 * via @google/genai — verified during apply task 1.3, confirmed in
 * design.md. No OpenAI-compat shim is needed.
 */
export const GEMINI_PROVIDER = "google" as const;

/**
 * Patch the resolved Google provider with a runtime-supplied API key.
 *
 * `configureProvider` is last-write-wins across the process — calling it
 * a second time with a different key replaces the first. Safe to invoke
 * from `createWorkbench` on every boot.
 */
export function configureGemini(apiKey: string): void {
  if (!apiKey) {
    throw new Error("configureGemini: apiKey must be a non-empty string");
  }
  configureProvider(GEMINI_PROVIDER, { apiKey });
}
