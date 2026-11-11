/** The Feature's code, as the lazy loader imports it. Marks its own evaluation, so a test can see WHEN. */

(globalThis as { __peershareEvaluated?: number }).__peershareEvaluated =
  ((globalThis as { __peershareEvaluated?: number }).__peershareEvaluated ?? 0) + 1;

export { peershareFeature } from "../../12-feature-contribution/src/feature.js";
