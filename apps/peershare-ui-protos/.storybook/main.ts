import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  // `*.mdx` pages carry the design discussion; `*.stories.tsx` carry the screens.
  stories: ["../src/**/*.mdx", "../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-docs", "@storybook/addon-themes"],
  core: { disableTelemetry: true },
};

export default config;
