<script lang="ts">
import type { ActionView } from "@kernel";
import { modelStore } from "./store.js";

/** Any action as a button: label, hint; disabled while not enabled or running. */
let { action, class: className }: { action: ActionView; class?: string } = $props();
const s = $derived(modelStore(action.getState, action.onStateUpdate));
</script>

<button
  type="button"
  class={className ?? "rounded border px-3 py-1 text-sm disabled:opacity-50"}
  title={$s.hint}
  aria-busy={$s.running}
  disabled={!$s.enabled || $s.running}
  onclick={() => action.submit()}
>{$s.label}</button>
