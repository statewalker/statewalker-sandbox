import { type ActionView, defineViewKind, type Listener } from "@kernel";

/** The hello panel: one presentation group (the count) and one action. */
export interface HelloView {
  getCount(): number;
  onCountUpdate(listener: Listener): () => void;
  readonly increment: ActionView;
}
export const helloKind = defineViewKind<HelloView>("hello:panel");
