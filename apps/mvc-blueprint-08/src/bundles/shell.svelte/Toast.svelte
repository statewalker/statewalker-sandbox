<script lang="ts">
import type { NotificationContribution } from "@b/shell/api";
import { modelStore } from "@kit/svelte";

let { item }: { item: NotificationContribution } = $props();
const s = $derived(modelStore(item.model.getState, item.model.onStateUpdate));
</script>

<div
  data-notification={item.id}
  data-tone={$s.tone}
  role={$s.tone === "error" ? "alert" : "status"}
  class="flex items-center gap-2 rounded border bg-white px-3 py-2 shadow"
>
  <span>{$s.message}</span>
  <button type="button" aria-label="Dismiss" onclick={() => item.model.dismiss()}>×</button>
</div>
