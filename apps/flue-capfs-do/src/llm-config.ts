// The deployment's model (the `LLM` var) and the credentials of one run: the deployment's key
// (`LLM_API_KEY`) or the caller's own token. Apart from agent-loop.ts so it can be unit-tested.

export interface LlmConfig {
  baseUrl: string;
  model: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  callerToken?: "allow" | "require" | "forbid";
  callerTokenHeader?: string;
}

/** The deployment's model, or undefined when none is configured. */
export function llmConfig(env: { LLM?: unknown }): LlmConfig | undefined {
  const raw = env.LLM;
  if (raw === undefined || raw === null || raw === "") return undefined;
  let c: Partial<LlmConfig>;
  try {
    c = typeof raw === "string" ? JSON.parse(raw) : (raw as Partial<LlmConfig>);
  } catch {
    throw new Error("EINVAL: LLM is not valid JSON");
  }
  if (typeof c.baseUrl !== "string" || typeof c.model !== "string") {
    throw new Error("EINVAL: LLM needs baseUrl and model");
  }
  if (c.callerToken !== undefined && !["allow", "require", "forbid"].includes(c.callerToken))
    throw new Error("EINVAL: LLM callerToken is allow, require or forbid");
  if (c.callerTokenHeader !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(c.callerTokenHeader))
    throw new Error("EINVAL: LLM callerTokenHeader is not a header name");
  return c as LlmConfig;
}

/**
 * The API key and extra headers for one run: the deployment's key, or the caller's token
 * (as the key, or in `callerTokenHeader` beside the deployment's key), as `callerToken` allows.
 */
export function llmCredentials(c: LlmConfig, deploymentKey: string | undefined, llmToken?: string) {
  const policy = c.callerToken ?? "allow";
  if (llmToken !== undefined) {
    if (typeof llmToken !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(llmToken))
      throw new Error("EINVAL: the model token is not a valid credential");
    if (policy === "forbid") throw new Error("EACCES: this deployment does not take model tokens");
    if (c.callerTokenHeader)
      return { apiKey: deploymentKey, headers: { [c.callerTokenHeader]: llmToken } };
    return { apiKey: llmToken, headers: {} };
  }
  if (policy === "require") throw new Error("EACCES: this deployment needs a model token");
  return { apiKey: deploymentKey, headers: {} };
}
