import { createProvider, type Provider } from "@earendil-works/pi-ai";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { setProvider } from "@flue/runtime";

/**
 * Canonical pi-ai provider id for Gemini. Used in model strings as
 * `google/gemini-2.5-flash`, `google/gemini-2.5-pro`, etc.
 */
export const GEMINI_PROVIDER = "google" as const;

/**
 * Build a pi-ai Google provider whose credential is the runtime-supplied
 * key rather than an environment variable.
 *
 * pi-ai's built-in `googleProvider()` resolves `GEMINI_API_KEY` from
 * `process.env`, which does not exist in the browser. Following Flue 2's
 * "route a built-in through your own credential" recipe, we register our
 * own provider under the built-in's id and reuse its catalog models, so
 * `google/<model>` specifiers and their metadata (context window, reasoning
 * support, cost) stay exactly as pi-ai ships them.
 */
export function createGeminiProvider(apiKey: string): Provider {
  if (!apiKey) {
    throw new Error("createGeminiProvider: apiKey must be a non-empty string");
  }
  return createProvider({
    id: GEMINI_PROVIDER,
    name: "Google",
    auth: {
      apiKey: {
        name: "Gemini API key (workbench secrets)",
        resolve: async () => ({ auth: { apiKey }, source: "workbench secrets" }),
      },
    },
    models: googleProvider().getModels(),
    api: googleGenerativeAIApi(),
  });
}

/**
 * Register the Gemini provider with the Flue runtime using `apiKey`.
 *
 * `setProvider` replaces any previous provider with the same id, so this is
 * last-write-wins across the process — calling it again with a different
 * key replaces the first. Safe to invoke from `createWorkbench` on every boot.
 */
export function configureGemini(apiKey: string): void {
  if (!apiKey) {
    throw new Error("configureGemini: apiKey must be a non-empty string");
  }
  setProvider(createGeminiProvider(apiKey));
}
