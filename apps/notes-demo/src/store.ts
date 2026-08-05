import type { FilesApi } from "@statewalker/webrun-files";
import { readText, writeText } from "@statewalker/webrun-files";

/** A single note. `id` is also its filename stem under the notes directory. */
export type Note = { id: string; title: string; body: string };

const DIR = "/notes";

/**
 * A tiny note store over any FilesApi — one JSON file per note under `/notes`.
 * FilesApi-only (no node:fs), so the same code runs on MemFilesApi (tests),
 * BrowserFilesApi/OPFS (persistent), or NodeFilesApi.
 */
export function makeStore(files: FilesApi) {
  return {
    async listNotes(): Promise<Note[]> {
      const notes: Note[] = [];
      for await (const entry of files.list(DIR)) {
        if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
        notes.push(JSON.parse(await readText(files, entry.path)) as Note);
      }
      return notes.sort((a, b) => a.title.localeCompare(b.title));
    },

    async saveNote(note: Note): Promise<void> {
      await writeText(files, `${DIR}/${note.id}.json`, JSON.stringify(note));
    },

    async deleteNote(id: string): Promise<void> {
      await files.remove(`${DIR}/${id}.json`);
    },
  };
}

export type NoteStore = ReturnType<typeof makeStore>;
