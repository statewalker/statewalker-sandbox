/** hello.ui.react — contributes the renderer of the minimal bundle. */
import { type Activator, getStore } from "../../kernel/index.ts";
import { helloKind } from "../hello/api/index.ts";
import { reactRenderers } from "../shell/api/react.ts";
import { Hello } from "./view.tsx";

export const activate: Activator = async (context) =>
  getStore(context).contribute(reactRenderers, helloKind.id, () => [Hello]);
