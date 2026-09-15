/**
 * The view layer's ONLY way into todo-app — spec §1.1, "Views know only models.
 * Nothing else. Never."
 *
 * `todo-ui` legitimately needs this layer: the models it renders live here, and
 * so do the `ui:` declarations its handlers bind (each carries the typed model
 * and result a view renders and returns). What it must never reach is anything
 * that orchestrates — a controller, `bootstrap`, the `ViewsReady` token. A
 * blanket ban on `@todo/app` would be wrong and a free-for-all is what the rule
 * forbids, so the separation is an entry point: `@todo/app/models`.
 *
 * B0 enforces both halves: a `todo-ui` source may import `@todo/app/models` and
 * nothing else from this layer (alias or relative path), and this module's
 * runtime exports contain no controller.
 */
export * from "./todo-model.js";
export * from "./ui-declarations.js";
