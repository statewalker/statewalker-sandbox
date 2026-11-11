import { composeStories } from "@storybook/react-vite";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, expect, it } from "vitest";
import * as bridge from "../src/peershare/bridge-status.stories.js";
import * as join from "../src/peershare/guest-join.stories.js";
import * as guests from "../src/peershare/guests.stories.js";
import * as invite from "../src/peershare/invite-dialog.stories.js";
import * as services from "../src/peershare/sharer-services.stories.js";
import * as viewer from "../src/peershare/viewer-frame.stories.js";
import * as scenario from "../src/scenario/scenario.stories.js";

afterEach(cleanup);

// Every story must render: a broken prototype otherwise only shows up as a red
// box in the published site.
const stories: [string, ComponentType][] = [
  ...Object.entries(composeStories(services)),
  ...Object.entries(composeStories(invite)),
  ...Object.entries(composeStories(guests)),
  ...Object.entries(composeStories(bridge)),
  ...Object.entries(composeStories(join)),
  ...Object.entries(composeStories(viewer)),
  ...Object.entries(composeStories(scenario)),
];

it("covers every screen", () => {
  expect(stories.length).toBeGreaterThanOrEqual(30);
});

it.each(stories)("%s renders", (_name, Story) => {
  const { container } = render(<Story />);
  expect(container.innerHTML).not.toBe("");
});
