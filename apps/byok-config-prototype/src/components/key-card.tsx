import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Label,
  Separator,
} from "@statewalker/ui.view.shadcn";
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Loader2,
  MoveDown,
  MoveUp,
  TestTube,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { CatalogModel, CatalogProvider } from "../catalog.js";
import type { ProviderKey, Tier } from "../config.js";
import { isConfigured } from "../config.js";
import { type TestOutcome, testConnection } from "../test-connection.js";
import { FilterRow } from "./filter-row.js";
import { Badge } from "./ui/badge.js";
import { Switch } from "./ui/switch.js";

/**
 * One expandable key card (guide steps 3–8): Name, API Key with a reveal
 * toggle, the "Always use for this provider" switch, the live Test control, and
 * the FILTERS section.
 */
export function KeyCard({
  index,
  tier,
  entry,
  provider,
  models,
  clientKeys,
  onChange,
  onRemove,
  onMove,
  onModelsDiscovered,
}: {
  index: number;
  tier: Tier;
  entry: ProviderKey;
  provider: CatalogProvider;
  /** Seed catalog, or the live list once a Test has succeeded. */
  models: CatalogModel[];
  clientKeys: Array<{ id: string; name: string }>;
  onChange: (patch: Partial<ProviderKey>) => void;
  onRemove: () => void;
  onMove: (to: Tier) => void;
  onModelsDiscovered: (models: CatalogModel[]) => void;
}) {
  // A brand-new key starts open, exactly as the guide's step 3 shows.
  const [open, setOpen] = useState(entry.apiKey === "");
  const [revealed, setRevealed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  const otherTier: Tier = tier === "prioritized" ? "fallback" : "prioritized";
  const saved = isConfigured(entry);

  async function runTest() {
    setTesting(true);
    setOutcome(null);
    const result = await testConnection(provider, entry.apiKey);
    setOutcome(result);
    setTesting(false);
    if (result.models && result.models.length > 0) onModelsDiscovered(result.models);
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border bg-card text-card-foreground"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="w-4 text-center text-muted-foreground text-sm">{index + 1}</span>
        <span className="flex-1 truncate font-medium text-sm">{entry.name || "New key"}</span>
        {!saved && <Badge variant="outline">not saved — no API key</Badge>}
        {!open && saved && (
          <span className="font-mono text-muted-foreground text-xs">{maskTail(entry.apiKey)}</span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Move to ${otherTier}`}
          title={`Move to ${otherTier}`}
          onClick={() => onMove(otherTier)}
        >
          {tier === "prioritized" ? <MoveDown /> : <MoveUp />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Remove key" onClick={onRemove}>
          <Trash2 />
        </Button>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={open ? "Collapse" : "Expand"}>
            {open ? <ChevronUp /> : <ChevronDown />}
          </Button>
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent>
        <Separator />
        <div className="space-y-4 px-4 py-4">
          <div className="space-y-1.5">
            <Label htmlFor={`name-${entry.id}`}>Name (optional)</Label>
            <Input
              id={`name-${entry.id}`}
              value={entry.name}
              placeholder="e.g. Production, Team A, Opus-only"
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`key-${entry.id}`}>API Key</Label>
            <div className="relative">
              <Input
                id={`key-${entry.id}`}
                type={revealed ? "text" : "password"}
                value={entry.apiKey}
                placeholder={provider.keyPlaceholder}
                className="pr-10 font-mono"
                onChange={(event) => onChange({ apiKey: event.target.value })}
              />
              <button
                type="button"
                aria-label={revealed ? "Hide API key" : "Reveal API key"}
                onClick={() => setRevealed((value) => !value)}
                className="-translate-y-1/2 absolute top-1/2 right-2 text-muted-foreground hover:text-foreground"
              >
                {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium text-sm">Always use for this provider</p>
              <p className="text-muted-foreground text-sm">
                Never fall back to the built-in endpoints.
              </p>
            </div>
            <Switch
              checked={entry.alwaysUse}
              aria-label="Always use for this provider"
              onCheckedChange={(checked) => onChange({ alwaysUse: checked })}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!saved || testing || provider.test === null}
              onClick={runTest}
            >
              {testing ? <Loader2 className="animate-spin" /> : <TestTube />}
              {testing ? "Testing…" : "Test"}
            </Button>
            {provider.test === null ? (
              <span className="text-muted-foreground text-xs">{provider.untestable}</span>
            ) : (
              outcome && (
                <span
                  title={outcome.message}
                  className={`inline-flex min-w-0 items-center gap-1.5 text-xs ${
                    outcome.ok ? "text-brand" : "text-destructive"
                  }`}
                >
                  {outcome.ok ? (
                    <CircleCheck className="size-3.5 shrink-0" />
                  ) : (
                    <CircleAlert className="size-3.5 shrink-0" />
                  )}
                  <span className="truncate">{outcome.message}</span>
                  <span className="shrink-0">· {outcome.ms} ms</span>
                </span>
              )
            )}
          </div>

          <Separator />

          <div>
            <p className="pb-1 font-medium text-muted-foreground text-xs tracking-wide">FILTERS</p>
            <FilterRow
              icon={<Globe className="size-4" />}
              label="Models"
              filter={entry.models}
              items={models}
              emptyLabel="No models known yet — run Test to load the provider's list."
              countNoun="models"
              mark={provider.mark}
              markClass={provider.markClass}
              onChange={(modelsFilter) => onChange({ models: modelsFilter })}
            />
            <FilterRow
              icon={<KeyRound className="size-4" />}
              label="API Keys"
              filter={entry.clientKeys}
              items={clientKeys.map((client) => ({
                id: client.id,
                label: client.name,
                group: "Client keys",
              }))}
              emptyLabel="This config declares no client API keys."
              countNoun="keys"
              mark="K"
              markClass="bg-secondary text-secondary-foreground"
              onChange={(clientKeysFilter) => onChange({ clientKeys: clientKeysFilter })}
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function maskTail(value: string): string {
  return value.length <= 6 ? "••••" : `••••${value.slice(-4)}`;
}
