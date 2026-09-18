import type { ContactDraft } from "@b/contacts/api";
import { type Context, getConfig } from "@kernel";

/** `sys:config` key: the delay of Save's first step (tests hold a commit between its two steps). */
export const VALIDATE_DELAY_KEY = "contacts:validate-ms";
export const getValidateDelay = (context: Context): number =>
  Number(getConfig(context)[VALIDATE_DELAY_KEY] ?? 0);

/**
 * Step 1 of Save, the multi-step commit (P3): an asynchronous check standing in for a server-side
 * validation. Step 2 is `contacts:update`. Both steps must act on the draft AT COMMIT TIME.
 */
export async function validateContact(
  draft: ContactDraft,
  delayMs: number,
): Promise<{ email: string; form: string } | undefined> {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  else await Promise.resolve();
  if (draft.email.trim() !== "" && !draft.email.includes("@")) {
    return { email: "Invalid email", form: "Invalid email" };
  }
  return undefined;
}
