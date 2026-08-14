import { Button } from "@statewalker/ui.view.shadcn";
import { ArrowLeft, ExternalLink, KeyRound, Plus } from "lucide-react";
import type { CatalogModel, CatalogProvider } from "../catalog.js";
import type { ConnectionsConfig, ProviderKey, Tier } from "../config.js";
import { providerOf } from "../config.js";
import { KeyCard } from "./key-card.js";

/** Guide steps 2–8 — one provider's prioritized and fallback key sections. */
export function ProviderScreen({
  provider,
  models,
  config,
  dirty,
  onBack,
  onSave,
  onAddKey,
  onUpdateKey,
  onRemoveKey,
  onMoveKey,
  onModelsDiscovered,
}: {
  provider: CatalogProvider;
  /** Seed catalog, or the live list once a Test has succeeded. */
  models: CatalogModel[];
  config: ConnectionsConfig;
  dirty: boolean;
  onBack: () => void;
  onSave: () => void;
  onAddKey: (tier: Tier) => void;
  onUpdateKey: (keyId: string, patch: Partial<ProviderKey>) => void;
  onRemoveKey: (keyId: string) => void;
  onMoveKey: (keyId: string, to: Tier) => void;
  onModelsDiscovered: (models: CatalogModel[]) => void;
}) {
  const entry = providerOf(config, provider.id);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-2 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        BYOK <span className="text-muted-foreground/60">›</span>{" "}
        <span className="text-foreground">{provider.name}</span>
      </button>

      <div className="mt-3 flex items-start justify-between gap-4 border-b pb-5">
        <div className="flex items-center gap-3">
          <span
            className={`flex size-9 shrink-0 items-center justify-center rounded-md font-semibold text-sm ${provider.markClass}`}
          >
            {provider.mark}
          </span>
          <div>
            <h1 className="font-bold text-2xl tracking-tight">{provider.name}</h1>
            <a
              href={provider.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground text-sm underline underline-offset-2 hover:text-foreground"
            >
              View supported models <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
        <Button
          disabled={!dirty}
          onClick={onSave}
          className="bg-brand text-brand-foreground hover:bg-brand/90"
        >
          Save
        </Button>
      </div>

      <div className="mt-6 grid gap-8 md:grid-cols-[16rem_1fr]">
        <aside className="text-sm">
          <p className="flex items-center gap-2 font-medium">
            <KeyRound className="size-4" />
            Provider Keys
          </p>
          <p className="mt-2 text-muted-foreground">
            Add and configure your API keys. Use a key's move button to send it to the other
            section.
          </p>
        </aside>

        <div className="space-y-8">
          <Section
            title="Prioritized"
            description="Attempted in order, before falling back to the built-in endpoints."
            emptyLabel="Add a prioritized key"
            tier="prioritized"
            keys={entry.prioritized}
            provider={provider}
            models={models}
            clientKeys={config.clientKeys}
            onAddKey={onAddKey}
            onUpdateKey={onUpdateKey}
            onRemoveKey={onRemoveKey}
            onMoveKey={onMoveKey}
            onModelsDiscovered={onModelsDiscovered}
          />
          <Section
            title="Fallback"
            description="Tried only after attempting the built-in endpoints, in order."
            emptyLabel="Add a fallback key"
            tier="fallback"
            keys={entry.fallback}
            provider={provider}
            models={models}
            clientKeys={config.clientKeys}
            onAddKey={onAddKey}
            onUpdateKey={onUpdateKey}
            onRemoveKey={onRemoveKey}
            onMoveKey={onMoveKey}
            onModelsDiscovered={onModelsDiscovered}
          />
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  emptyLabel,
  tier,
  keys,
  provider,
  models,
  clientKeys,
  onAddKey,
  onUpdateKey,
  onRemoveKey,
  onMoveKey,
  onModelsDiscovered,
}: {
  title: string;
  description: string;
  emptyLabel: string;
  tier: Tier;
  keys: ProviderKey[];
  provider: CatalogProvider;
  models: CatalogModel[];
  clientKeys: ConnectionsConfig["clientKeys"];
  onAddKey: (tier: Tier) => void;
  onUpdateKey: (keyId: string, patch: Partial<ProviderKey>) => void;
  onRemoveKey: (keyId: string) => void;
  onMoveKey: (keyId: string, to: Tier) => void;
  onModelsDiscovered: (models: CatalogModel[]) => void;
}) {
  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-sm">{title}</h2>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => onAddKey(tier)}>
          <Plus />
          Add key
        </Button>
      </div>

      <div className="mt-3 space-y-3">
        {keys.length === 0 ? (
          <button
            type="button"
            onClick={() => onAddKey(tier)}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed py-8 text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-4" />
            {emptyLabel}
          </button>
        ) : (
          keys.map((entry, index) => (
            <KeyCard
              key={entry.id}
              index={index}
              tier={tier}
              entry={entry}
              provider={provider}
              models={models}
              clientKeys={clientKeys}
              onChange={(patch) => onUpdateKey(entry.id, patch)}
              onRemove={() => onRemoveKey(entry.id)}
              onMove={(to) => onMoveKey(entry.id, to)}
              onModelsDiscovered={onModelsDiscovered}
            />
          ))
        )}
      </div>
    </section>
  );
}
