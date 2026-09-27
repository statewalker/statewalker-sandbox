import { MemTodoApi } from "@todo/core";

/**
 * The real in-memory api, holding one todo — id `"1"`, open unless `done` —
 * which is what the protocol suites boot a controller over. The real thing,
 * not a hand-rolled look-alike: a suite taking the view layer only as
 * `@todo/ui/adapter` may import the core (B0 binds only suites that render
 * views), so there is no longer a reason to copy it.
 */
export const seededApi = (done = false): MemTodoApi =>
  new MemTodoApi([{ id: "1", title: "seed", done }]);
