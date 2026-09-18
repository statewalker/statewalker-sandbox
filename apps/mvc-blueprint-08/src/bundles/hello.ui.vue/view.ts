import type { HelloView } from "@b/hello/api";
import { ActionButton, modelProp, useModel } from "@kit/vue";
import { defineComponent, h } from "vue";

export const Hello = defineComponent({
  props: { model: modelProp<HelloView>() },
  setup({ model }) {
    const count = useModel(model.getCount, model.onCountUpdate);
    return () =>
      h("div", { class: "flex items-center gap-3" }, [
        h("p", { "data-hello-count": "" }, `Count: ${count.value}`),
        h(ActionButton, { action: model.increment }),
      ]);
  },
});
