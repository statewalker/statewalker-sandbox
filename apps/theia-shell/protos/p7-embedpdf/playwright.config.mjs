import { fileURLToPath } from "node:url";
import { appConfig } from "../../tools/playwright.base.mjs";

export default appConfig({ appDir: fileURLToPath(new URL(".", import.meta.url)), port: 3107 });
