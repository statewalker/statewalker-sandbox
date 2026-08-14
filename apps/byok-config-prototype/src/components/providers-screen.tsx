import { Input } from "@statewalker/ui.view.shadcn";
import { ChevronRight, Search } from "lucide-react";
import { useState } from "react";
import { PROVIDERS } from "../catalog.js";
import type { ConnectionsConfig } from "../config.js";
import { keyCount } from "../config.js";

/** Guide step 1 — the provider list with a per-provider configuration status. */
export function ProvidersScreen({
  config,
  onOpenProvider,
}: {
  config: ConnectionsConfig;
  onOpenProvider: (providerId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const providers = needle
    ? PROVIDERS.filter((provider) => provider.name.toLowerCase().includes(needle))
    : PROVIDERS;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <h1 className="font-bold text-3xl tracking-tight">BYOK</h1>

      <div className="mt-6 flex items-center justify-between gap-6">
        <p className="font-medium text-sm">Use your own provider API keys</p>
        <div className="relative w-80">
          <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search providers..."
            className="pl-9"
          />
        </div>
      </div>

      <p className="mt-6 font-semibold text-sm">Available</p>
      <div className="mt-2 divide-y rounded-xl border bg-card">
        {providers.map((provider) => {
          const count = keyCount(config, provider.id);
          return (
            <button
              key={provider.id}
              type="button"
              onClick={() => onOpenProvider(provider.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left first:rounded-t-xl last:rounded-b-xl hover:bg-accent"
            >
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-md font-semibold text-xs ${provider.markClass}`}
              >
                {provider.mark}
              </span>
              <span className="flex-1 truncate text-sm">{provider.name}</span>
              <span className="text-muted-foreground text-sm">
                {count === 0 ? "Not configured" : `${count} key${count === 1 ? "" : "s"}`}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          );
        })}
        {providers.length === 0 && (
          <p className="px-4 py-8 text-center text-muted-foreground text-sm">
            No provider matches “{query}”.
          </p>
        )}
      </div>
    </div>
  );
}
