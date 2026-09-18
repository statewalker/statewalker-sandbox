import { type ActionView, defineViewKind } from "../../../kernel/models.js";

export interface HelloView {
  getState(): { readonly count: number };
  onStateUpdate(listener: () => void): () => void;
  readonly increment: ActionView;
}
export const helloKind = defineViewKind<HelloView>("hello:panel");
