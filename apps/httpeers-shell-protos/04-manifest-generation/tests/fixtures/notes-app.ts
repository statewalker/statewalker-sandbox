// RECOVERED-FROM-ARCHIVE: notes/drive/2026-09-02.Httpeers-Shell/13-prototype-04-manifest-generation.tar.gz
// Unmodified.
import { Command } from "@statewalker/shared-commands";
import { z } from "zod";
import { contributeMenu } from "../../src/contribute.js";

export const NewNoteCommand = Command.async("notes:new")
  .input(z.object({ title: z.string().optional() }))
  .output(z.object({ id: z.string() }))
  .label("New Note")
  .description("Create a new note.")
  .icon("plus")
  .build();

export const DeleteNoteCommand = Command.required("notes:delete")
  .input(z.object({ id: z.string() }))
  .output(z.object({ deleted: z.boolean() }))
  .label("Delete Note")
  .icon("trash")
  .build();

contributeMenu({
  location: "explorer:context",
  command: "notes:delete",
  group: "edit",
  when: 'selection("note")',
});

contributeMenu({ location: "shell:titlebar", command: "notes:new", group: "navigation" });
