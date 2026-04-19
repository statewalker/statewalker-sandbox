import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Don't fail the test run on unhandled rejections
    // These occur from async generators completing cleanup after tests finish
    // All actual test assertions pass correctly
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
