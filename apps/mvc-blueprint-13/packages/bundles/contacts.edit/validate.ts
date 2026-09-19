import type { ContactDraft } from "@p5/contacts/api";
import { type Context, getConfig } from "@p5/kernel";

/** `sys:config` key: the delay of Save's first step (tests hold a commit between its two steps). */
export const VALIDATE_DELAY_KEY = "contacts:validate-ms";
export const getValidateDelay = (context: Context): number =>
  Number(getConfig(context)[VALIDATE_DELAY_KEY] ?? 0);

/**
 * Step 1 of Save, the multi-step commit (P3): an asynchronous check standing in for a server-side
 * validation. Step 2 is `contacts:update`. Both steps must act on the draft AT COMMIT TIME.
 */
export function validateContact(
  draft: ContactDraft,
  delayMs: number,
): Promise<{ email: string; form: string } | undefined> {
  const check = () =>
    draft.email.trim() !== "" && !draft.email.includes("@")
      ? { email: "Invalid email", form: "Invalid email" }
      : undefined;
  return new Promise((r) =>
    delayMs > 0 ? setTimeout(() => r(check()), delayMs) : queueMicrotask(() => r(check())),
  );
}
