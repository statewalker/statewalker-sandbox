import { z } from "zod";
import { Command } from "@statewalker/shared-commands";

/** A resolved location. Never panel identity — that is what lets jobs outlive panels. */
export const fileRef = z.object({
  storage: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory"]),
});
export type FileRef = z.infer<typeof fileRef>;

export const target = z.object({ storage: z.string(), path: z.string() });

/**
 * Uniform payload contract: `{ files: FileRef[] }`, ALWAYS an array even for
 * one file, so single-file and multi-file paths never branch in the panel.
 * Locations are resolved before dispatch and panel identity never appears —
 * which is what lets an agent or a host call these directly.
 */
export const filesCopy = Command.required("files:copy")
  .input(z.object({ files: z.array(fileRef), target }))
  .output(z.object({ jobId: z.string() }))
  .label("Copy")
  .description("Copy the selected files to another location")
  .build();

export const filesMove = Command.required("files:move")
  .input(z.object({ files: z.array(fileRef), target }))
  .output(z.object({ jobId: z.string() }))
  .label("Move")
  .description("Move the selected files to another location")
  .build();

export const filesDelete = Command.required("files:delete")
  .input(z.object({ files: z.array(fileRef) }))
  .output(z.object({ jobId: z.string() }))
  .label("Delete")
  .description("Delete the selected files")
  .build();

export const filesMkdir = Command.required("files:mkdir")
  .input(z.object({ target, name: z.string().min(1) }))
  .output(z.object({ path: z.string() }))
  .label("New folder")
  .build();

export const filesRename = Command.required("files:rename")
  .input(z.object({ files: z.array(fileRef).length(1), name: z.string().min(1) }))
  .output(z.object({ path: z.string() }))
  .label("Rename")
  .build();

/**
 * Applicability, asked rather than encoded. A registry is a flat catalog with
 * no notion of what applies to what; rather than putting predicates in the
 * schema or keeping a side table, the app ASKS the host which keys apply to a
 * selection. When no handler claims it, the whole namespace is offered — the
 * app owns no MIME table and invents no extension rules.
 */
export const filesResolveActions = Command.required("files:resolve-actions")
  .input(z.object({ files: z.array(fileRef) }))
  .output(z.object({ keys: z.array(z.string()) }))
  .build();

/**
 * Opening a filesystem is a COMMAND, like everything else.
 *
 * Nothing in the app constructs a `FilesApi`. The environment answers this:
 * in a browser with a real handler, `showDirectoryPicker()` and a permission
 * prompt; in a test, an in-memory filesystem; in a host embedding us, whatever
 * that host already has mounted. The app cannot tell the difference, and that
 * is the point — the picker is not a special case, it is a handler.
 *
 * The core registers NO fallback for this. There is no sensible default
 * filesystem to invent, so an unwired environment fails loudly with
 * `no-handlers` rather than quietly opening something nobody asked for.
 */
export const storagesOpen = Command.required("storages:open")
  .input(
    z.object({
      /** What the caller wants it for; a handler may ask for write access. */
      mode: z.enum(["read", "readwrite"]).default("read"),
      suggestedName: z.string().optional(),
    }),
  )
  .output(
    z.object({
      cancelled: z.boolean(),
      uri: z.string().optional(),
      name: z.string().optional(),
    }),
  )
  .label("Open folder…")
  .description("Ask the environment for a filesystem to work with")
  .build();

/** Every file command, in declaration order. */
export const FILE_COMMANDS = [
  filesCopy, filesMove, filesDelete, filesMkdir, filesRename,
] as const;
