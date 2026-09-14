export interface Regions {
  readonly main: HTMLElement;
  readonly side: HTMLElement;
  readonly bottom: HTMLElement;
  readonly progress: HTMLElement;
  readonly dialogs: HTMLElement;
}

const region = (name: string, className: string): HTMLElement => {
  const node = document.createElement("div");
  node.dataset.region = name;
  node.className = className;
  return node;
};

/** The page's regions. Placement names map to regions; hosts receive the ones they render. */
export function createLayout(root: HTMLElement): Regions {
  const grid = document.createElement("div");
  grid.className =
    "mx-auto grid max-w-6xl grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]";
  const main = region("main", "min-w-0");
  const aside = document.createElement("aside");
  aside.className = "flex flex-col gap-4";
  const progress = region("progress", "flex flex-col gap-2");
  const side = region("side", "flex flex-col gap-4");
  aside.append(progress, side);
  const bottom = region("bottom", "lg:col-span-2");
  const dialogs = region("dialogs", "");
  grid.append(main, aside, bottom);
  root.append(grid, dialogs);
  return { main, side, bottom, progress, dialogs };
}
