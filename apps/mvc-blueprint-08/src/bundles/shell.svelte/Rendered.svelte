<script lang="ts">
import type { DialogContribution, PanelContribution } from "@b/shell/api";
import type { SvelteRenderer } from "@b/shell/api/svelte";
import type { Component } from "svelte";

/** A contribution whose kind has a renderer; otherwise nothing (the coverage report lists it). */
let {
  contribution,
  renderers,
}: {
  contribution: PanelContribution | DialogContribution;
  renderers: ReadonlyMap<string, SvelteRenderer<never>>;
} = $props();
const View = $derived(
  renderers.get(contribution.kind.id)?.component as Component<{ model: unknown }> | undefined,
);
</script>

{#if View}<View model={contribution.model} />{/if}
