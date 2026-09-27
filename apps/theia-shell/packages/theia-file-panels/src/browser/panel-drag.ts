import URI from "@theia/core/lib/common/uri";

/** Marks a drag that started in a file panel; the explorer recognises panel drags by it. */
export const PANEL_DRAG_TYPE = "theia-file-panels/uris";

export function writePanelDrag(data: DataTransfer, uris: URI[]): void {
  data.setData(PANEL_DRAG_TYPE, uris.map((uri) => uri.toString()).join("\n"));
}

/** Must be called synchronously inside the drop event: the browser clears the data afterwards. */
export function readPanelDrag(data: DataTransfer): URI[] {
  const text = data.getData(PANEL_DRAG_TYPE);
  return text ? text.split("\n").map((line) => new URI(line)) : [];
}
