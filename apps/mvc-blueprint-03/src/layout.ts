export interface Regions {
  readonly main: HTMLElement;
  readonly side: HTMLElement;
  readonly dialogs: HTMLElement;
  readonly notifications: HTMLElement;
}

const region = (name: string, className: string): HTMLElement => {
  const node = document.createElement("div");
  node.dataset.region = name;
  node.className = className;
  return node;
};

/** The page's regions: placements map to `main` and `side`; dialogs and notifications have their own containers. */
export function createLayout(root: HTMLElement): Regions {
  const grid = document.createElement("div");
  grid.className =
    "mx-auto grid max-w-6xl grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]";
  const main = region("main", "min-w-0");
  const side = region("side", "flex flex-col gap-4");
  grid.append(main, side);
  const dialogs = region("dialogs", "");
  const notifications = region("notifications", "fixed right-4 bottom-4 z-50");
  root.append(grid, dialogs, notifications);
  return { main, side, dialogs, notifications };
}
