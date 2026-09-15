export * from "./model-kit.js";
export * from "./todo-model.js";
export * from "./ui-declarations.js";
export * from "./list-controller.js";
export * from "./menu-controller.js";
// TYPE only. Exporting the class value would hand every caller `_mint()` — a
// public static — and with it a token that activates a controller with no view
// layer registered. B0 confines `_mint` to `views-ready.ts` and `bootstrap.ts`.
export type { ViewsReady } from "./views-ready.js";
export * from "./bootstrap.js";
