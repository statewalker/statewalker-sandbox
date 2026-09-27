// Shared Playwright config for every browser-only app in this workspace: build
// output in <appDir>/lib/frontend is served statically, nothing else runs.
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const serve = fileURLToPath(new URL("./serve.mjs", import.meta.url));

export function appConfig({ appDir, port }) {
  return defineConfig({
    testDir: `${appDir}/tests`,
    timeout: 60_000,
    expect: { timeout: 20_000 },
    fullyParallel: false,
    workers: 1,
    reporter: "list",
    use: {
      baseURL: `http://127.0.0.1:${port}`,
      ...devices["Desktop Chrome"],
      viewport: { width: 1400, height: 900 },
      trace: "retain-on-failure",
    },
    webServer: {
      command: `node ${serve} ${appDir}/lib/frontend ${port}`,
      url: `http://127.0.0.1:${port}/__health`,
      reuseExistingServer: false,
    },
  });
}
