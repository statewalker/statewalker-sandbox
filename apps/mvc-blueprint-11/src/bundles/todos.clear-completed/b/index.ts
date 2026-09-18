/**
 * `todos.clear-completed`, mechanism B: nothing to hand over. Clear completed acts on the todos
 * that are done — another bundle's collection, not a form this bundle owns — and the confirmation
 * carries no draft. A form `commit()` has no form to live in, so this bundle keeps the controller
 * snapshot (mechanism A) unchanged.
 */
export { activate } from "../a/index.js";
