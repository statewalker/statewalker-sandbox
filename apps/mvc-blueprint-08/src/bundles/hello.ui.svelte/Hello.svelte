<script lang="ts">
import type { HelloView } from "@b/hello/api";
import { ActionButton, modelStore } from "@kit/svelte";

let { model }: { model: HelloView } = $props();
const count = $derived(modelStore(model.getCount, model.onCountUpdate));
</script>

<div class="flex items-center gap-3">
  <p data-hello-count>Count: {$count}</p>
  <ActionButton action={model.increment} />
</div>
