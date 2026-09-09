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
