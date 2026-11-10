import { isUpdatableName } from "./batch-rules.js";

export { compareRefNames } from "./refname.js";
/** A name a batch may update or a symbolic ref may point at. */
export const isUpdatableNameOrSymTarget = (name: string) => isUpdatableName(name);
