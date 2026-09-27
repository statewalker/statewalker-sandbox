import { nls } from "@theia/core/lib/common/nls";

/** The UI locale Theia runs in; "en" when none is set (and outside a browser). */
export function currentLocale(): string {
  try {
    return nls.locale ?? "en";
  } catch {
    return "en";
  }
}
