import { fileURLToPath } from "node:url";
import { appConfig } from "../tools/playwright.base.mjs";

export default appConfig({
  appDir: fileURLToPath(new URL(".", import.meta.url)),
  port: Number(process.env.THEIA_SHELL_E2E_PORT ?? 3100),
});
