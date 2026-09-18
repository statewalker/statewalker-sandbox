import { type HelloView, helloKind } from "@b/hello/api";
import { type DomRenderer, domRenderersSlot } from "@b/shell/api/dom";
import { type Controller, getSlots } from "@kernel";
import { actionButton, bind, h } from "@kit/dom";

function mount(host: HTMLElement, model: HelloView): () => void {
  const count = h("p", { "data-hello-count": true });
  const button = actionButton(model.increment);
  host.append(h("div", { class: "flex items-center gap-3" }, count, button.el));
  const off = bind(model.getCount, model.onCountUpdate, (n) => (count.textContent = `Count: ${n}`));
  return () => {
    off();
    button.dispose();
    host.replaceChildren();
  };
}

/** `hello.ui.dom`: the hello panel's DOM renderer. */
export const activate: Controller = async (context) =>
  getSlots(context).register(domRenderersSlot, helloKind.id, {
    kind: helloKind,
    mount,
  } satisfies DomRenderer<HelloView> as unknown as DomRenderer<never>);
