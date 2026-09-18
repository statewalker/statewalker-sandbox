import { type ActionDesc, defineViewKind } from "../../../kernel/index.js";

export interface HelloState {
  readonly count: number;
  readonly increment: ActionDesc;
}
export const helloKind = defineViewKind<HelloState, never>("hello:counter");
