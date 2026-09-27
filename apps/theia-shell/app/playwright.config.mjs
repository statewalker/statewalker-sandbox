import { fileURLToPath } from "node:url";
import { appConfig } from "../tools/playwright.base.mjs";

// E2E_PORT lets suites from several worktrees run side by side.
const port = Number(process.env.E2E_PORT ?? 3100);

export default appConfig({ appDir: fileURLToPath(new URL(".", import.meta.url)), port });
