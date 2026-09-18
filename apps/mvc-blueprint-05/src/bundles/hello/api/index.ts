import { type ActionItem, defineViewKind } from "../../../kernel/index.ts";

export const helloKind = defineViewKind<{ count: number; increment: ActionItem }>("hello:panel");
