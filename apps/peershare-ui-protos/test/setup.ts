import { configure } from "@testing-library/react";

// findBy* waits 1 s by default; a loaded machine renders a prototype step slower than that.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no ResizeObserver; dockview needs one to exist, not to fire.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom has no scrollTo; assistant-ui's thread viewport auto-scroll calls it.
Element.prototype.scrollTo ??= () => {};

// jsdom has no DragEvent; without it drag events lose ctrlKey and dataTransfer.
globalThis.DragEvent ??= class DragEvent extends MouseEvent {
  readonly dataTransfer: DataTransfer | null = null;
} as typeof globalThis.DragEvent;
