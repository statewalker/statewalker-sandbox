/**
 * D1 lands here. `fm-ui` exists now only so the boundary grep has a third
 * package to hold to its rule: nothing in here may import `@fm/core` directly —
 * the view layer talks to models and the bus, never to the engine.
 */
export {};
