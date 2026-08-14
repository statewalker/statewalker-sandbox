import { Button, Input, ScrollArea } from "@statewalker/ui.view.shadcn";
import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

export interface PickerItem {
  id: string;
  label: string;
  group: string;
}

/**
 * Step 7 of the guide: "+ Add" opens a searchable dropdown listing all models,
 * grouped by release date, with a live match count in the search row.
 */
export function ItemPicker({
  items,
  selected,
  emptyLabel,
  countNoun,
  mark,
  markClass,
  onToggle,
}: {
  items: PickerItem[];
  selected: string[];
  emptyLabel: string;
  countNoun: string;
  /** Provider mark shown on each row, standing in for the provider logo. */
  mark: string;
  markClass: string;
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? items.filter((item) => item.label.toLowerCase().includes(needle))
      : items;
    const byGroup = new Map<string, PickerItem[]>();
    for (const item of matched) {
      const bucket = byGroup.get(item.group);
      if (bucket) bucket.push(item);
      else byGroup.set(item.group, [item]);
    }
    return { matched, entries: [...byGroup] };
  }, [items, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 rounded-full border-dashed px-2.5 text-xs"
        >
          + Add
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${countNoun}`}
            className="h-10 border-0 px-0 shadow-none focus-visible:ring-0"
          />
          <span className="shrink-0 text-muted-foreground text-xs">
            {groups.matched.length} {countNoun}
          </span>
        </div>

        <ScrollArea className="h-72">
          {groups.entries.length === 0 ? (
            <p className="px-3 py-6 text-center text-muted-foreground text-sm">{emptyLabel}</p>
          ) : (
            groups.entries.map(([group, groupItems]) => (
              <div key={group} className="py-1">
                <p className="px-3 py-1 text-muted-foreground text-xs">{group}</p>
                {groupItems.map((item) => {
                  const isSelected = selected.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onToggle(item.id)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                    >
                      <span
                        className={`flex size-5 shrink-0 items-center justify-center rounded font-semibold text-[10px] ${markClass}`}
                      >
                        {mark}
                      </span>
                      <span className="flex-1 truncate">{item.label}</span>
                      {isSelected && <Check className="size-4 shrink-0 text-brand" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
