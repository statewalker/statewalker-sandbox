<script lang="ts">
import type { HeaderContribution } from "@b/shell/api";
import { modelStore } from "@kit/svelte";

let { item }: { item: HeaderContribution } = $props();
const s = $derived(modelStore(item.model.getState, item.model.onStateUpdate));
</script>

<span data-header-item={item.id}>{$s.text}</span>
