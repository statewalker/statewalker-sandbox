import type { TestProject } from "vitest/node";
import type { Fixtures } from "../src/types.js";
import { makeFixtures } from "./make-fixtures.js";

declare module "vitest" {
  interface ProvidedContext {
    fixtures: Fixtures;
  }
}

export default function setup(project: TestProject) {
  project.provide("fixtures", makeFixtures());
}
