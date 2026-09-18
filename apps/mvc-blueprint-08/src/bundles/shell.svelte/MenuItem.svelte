<script lang="ts">
import type { MenuContribution } from "@b/shell/api";
import { modelStore } from "@kit/svelte";

let { item }: { item: MenuContribution } = $props();
const s = $derived(modelStore(item.action.getState, item.action.onStateUpdate));
</script>

<button
  type="button"
  role="menuitem"
  class="px-3 py-1 text-left disabled:opacity-50"
  disabled={!$s.enabled || $s.running}
  onclick={(event) => {
    item.action.submit();
    event.currentTarget.closest("details")?.removeAttribute("open");
  }}>{$s.label}</button>
