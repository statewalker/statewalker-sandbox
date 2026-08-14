import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { Filter } from "../config.js";
import { toggleFilterId } from "../config.js";
import { ItemPicker, type PickerItem } from "./item-picker.js";
import { Segmented } from "./ui/segmented.js";

const MODES = [
  { value: "all", label: "All" },
  { value: "specific", label: "Specific" },
] as const;

/**
 * One row of the FILTERS section (steps 6–8): a label, the All/Specific
 * segmented control, and — while "Specific" — an "+ Add" picker plus a
 * removable chip per selected id.
 */
export function FilterRow({
  icon,
  label,
  filter,
  items,
  emptyLabel,
  countNoun,
  mark,
  markClass,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  filter: Filter;
  items: PickerItem[];
  emptyLabel: string;
  countNoun: string;
  mark: string;
  markClass: string;
  onChange: (filter: Filter) => void;
}) {
  const selected = filter.mode === "specific" ? filter.ids : [];

  return (
    <div className="py-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{icon}</span>
          <span className="font-medium">{label}</span>
        </div>
        <Segmented
          ariaLabel={`${label} filter`}
          value={filter.mode}
          options={MODES}
          onChange={(mode) => onChange(mode === "all" ? { mode: "all" } : { mode, ids: selected })}
        />
      </div>

      {filter.mode === "specific" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ItemPicker
            items={items}
            selected={selected}
            emptyLabel={emptyLabel}
            countNoun={countNoun}
            mark={mark}
            markClass={markClass}
            onToggle={(id) => onChange(toggleFilterId(filter, id))}
          />
          {selected.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 rounded-full bg-secondary py-1 pr-1.5 pl-2.5 text-xs"
            >
              {items.find((item) => item.id === id)?.label ?? id}
              <button
                type="button"
                aria-label={`Remove ${id}`}
                onClick={() => onChange(toggleFilterId(filter, id))}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
