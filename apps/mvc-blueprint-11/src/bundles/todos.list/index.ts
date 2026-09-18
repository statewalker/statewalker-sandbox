import { byMechanism } from "@kit/mechanism";
import { activate as a } from "./a/index.js";
import { activate as b } from "./b/index.js";
import { activate as c } from "./c/index.js";

/** P3: the same bundle three ways — see `@kit/mechanism`. */
export const activate = byMechanism({ A: a, B: b, C: c });
