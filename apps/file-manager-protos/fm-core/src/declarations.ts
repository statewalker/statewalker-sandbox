import { Command } from "@statewalker/shared-commands";
import { z } from "zod";

/** A resolved location. Never panel identity — that is what lets jobs outlive panels. */
export const fileRef = z.object({
  storage: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory"]),
});
export type FileRef = z.infer<typeof fileRef>;

/** Uniform payload contract: always an array, even for one file. */
export const filesCopy = Command.required("files:copy")
  .input(
    z.object({
      files: z.array(fileRef),
      target: z.object({ storage: z.string(), path: z.string() }),
    }),
  )
  .output(z.object({ jobId: z.string() }))
  .label("Copy")
  .build();

/**
 * The rest of the file namespace. Declared HERE, in the core, because `files:*`
 * is core vocabulary — the same reason P5 moved `ui:show-job` out to the app
 * layer. Every one registers its own handler at NEGATIVE priority, the package's
 * documented fallback convention, so a host overrides any of them by listening
 * at 0: route delete to a trash mount, add an approval step, block writes on a
 * read-only storage.
 *
 * Payloads carry resolved locations and never panel identity, which is what lets
 * a job survive panel removal — and it means the target picker runs before
 * dispatch, in the view, so a host or an agent that already knows the target
 * skips the picker entirely.
 */
const target = z.object({ storage: z.string(), path: z.string() });

export const filesMove = Command.required("files:move")
  .input(z.object({ files: z.array(fileRef), target }))
  .output(z.object({ jobId: z.string() }))
  .label("Move")
  .build();

export const filesDelete = Command.required("files:delete")
  .input(z.object({ files: z.array(fileRef) }))
  .output(z.object({ removed: z.number() }))
  .label("Delete")
  .build();

/**
 * The one command that does NOT take `{ files: FileRef[] }`. The uniform payload
 * contract is about acting on a SELECTION; `mkdir` creates something that does
 * not exist yet, and a `FileRef` for it would be a reference to nothing.
 */
export const filesMkdir = Command.required("files:mkdir")
  .input(z.object({ storage: z.string(), path: z.string() }))
  .output(z.object({ path: z.string() }))
  .label("New folder")
  .build();

export const filesRename = Command.required("files:rename")
  .input(z.object({ files: z.array(fileRef), name: z.string() }))
  .output(z.object({ path: z.string() }))
  .label("Rename")
  .build();

/** Every key a selection can be offered. */
export const ACTION_KEYS = [
  "files:copy",
  "files:delete",
  "files:mkdir",
  "files:move",
  "files:rename",
] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];

/**
 * The applicability mechanism. A registry is a flat catalog with no notion of
 * applicability, so rather than encoding predicates in the schema or keeping a
 * side table, the app asks the host and receives the applicable keys. All policy
 * stays host-side: the app owns no MIME table and invents no extension rules.
 *
 * `required` policy on purpose — "nobody answered" has to be distinguishable
 * from "answered, and nothing applies". The first offers the whole namespace;
 * the second offers none of it.
 */
export const filesResolveActions = Command.required("files:resolve-actions")
  .input(z.object({ files: z.array(fileRef) }))
  .output(z.object({ actions: z.array(z.enum(ACTION_KEYS)) }))
  .build();
