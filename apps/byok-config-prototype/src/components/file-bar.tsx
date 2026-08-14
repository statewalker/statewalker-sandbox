import { Button, Separator } from "@statewalker/ui.view.shadcn";
import { Braces, FilePlus2, FolderOpen, Save } from "lucide-react";
import type { ConfigFile } from "../file-store.js";
import { Badge } from "./ui/badge.js";

/**
 * Prototype chrome: which file is open, whether it can be written back in
 * place, and the open / new / save actions. The BYOK screens have no such bar
 * — it stands in for "the app owns the config document".
 */
export function FileBar({
  file,
  dirty,
  status,
  previewOpen,
  onOpen,
  onNew,
  onSave,
  onSaveAs,
  onTogglePreview,
}: {
  file: ConfigFile | null;
  dirty: boolean;
  status: string | null;
  previewOpen: boolean;
  onOpen: () => void;
  onNew: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onTogglePreview: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-3 px-6 py-2.5">
        <span className="font-semibold text-sm">Connections config</span>
        <Separator orientation="vertical" className="h-5" />

        <span className="truncate font-mono text-muted-foreground text-xs">
          {file ? file.name : "no file — in-memory draft"}
        </span>
        {dirty && <Badge variant="brand">unsaved</Badge>}
        {file && !file.canWriteInPlace && <Badge variant="outline">saves as a download</Badge>}

        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onTogglePreview}>
            <Braces />
            {previewOpen ? "Hide JSON" : "Show JSON"}
          </Button>
          <Button variant="outline" size="sm" onClick={onNew}>
            <FilePlus2 />
            New
          </Button>
          <Button variant="outline" size="sm" onClick={onOpen}>
            <FolderOpen />
            Open
          </Button>
          <Button variant="outline" size="sm" onClick={onSaveAs}>
            Save a copy
          </Button>
          <Button
            size="sm"
            disabled={!dirty}
            onClick={onSave}
            className="bg-brand text-brand-foreground hover:bg-brand/90"
          >
            <Save />
            Save
          </Button>
        </div>
      </div>

      {status && (
        <p className="mx-auto w-full max-w-5xl px-6 pb-2 text-muted-foreground text-xs">{status}</p>
      )}
    </header>
  );
}
