import { useCallback, useEffect, useState } from "react";
import type { NoteStore, Note } from "./store.js";

/** Stable id for a fresh note (no crypto dependency needed). */
const newId = () => `n-${Date.now().toString(36)}`;

export function App({ store, onChange }: { store: NoteStore; onChange?: () => void }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const reload = useCallback(async () => {
    setNotes(await store.listNotes());
  }, [store]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const edit = (note: Note) => {
    setId(note.id);
    setTitle(note.title);
    setBody(note.body);
  };

  const blank = () => {
    setId(null);
    setTitle("");
    setBody("");
  };

  const save = async () => {
    const note: Note = { id: id ?? newId(), title: title.trim() || "Untitled", body };
    await store.saveNote(note);
    blank();
    await reload();
    onChange?.();
  };

  const remove = async (target: string) => {
    await store.deleteNote(target);
    if (target === id) blank();
    await reload();
    onChange?.();
  };

  return (
    <div className="flex h-screen gap-4 p-4 text-slate-800">
      <aside className="flex w-64 flex-col gap-2">
        <header className="flex items-center gap-2">
          <span className="logo" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-brand">Notes</h1>
        </header>
        <button
          type="button"
          onClick={blank}
          className="rounded bg-brand px-3 py-2 text-left text-sm font-medium text-white hover:opacity-90"
        >
          + New note
        </button>
        <ul className="flex flex-col gap-1 overflow-y-auto">
          {notes.map((note) => (
            <li key={note.id} className="note-card flex items-center gap-2 rounded">
              <button
                type="button"
                onClick={() => edit(note)}
                className={`flex-1 truncate rounded px-2 py-1 text-left text-sm hover:bg-slate-100 ${
                  note.id === id ? "bg-slate-100 font-medium" : ""
                }`}
              >
                {note.title}
              </button>
              <button
                type="button"
                onClick={() => remove(note.id)}
                aria-label={`Delete ${note.title}`}
                className="rounded px-2 py-1 text-sm text-slate-400 hover:text-red-600"
              >
                ×
              </button>
            </li>
          ))}
          {notes.length === 0 && (
            <li className="px-2 py-1 text-sm text-slate-400">No notes yet.</li>
          )}
        </ul>
      </aside>

      <section className="flex flex-1 flex-col gap-3 rounded border border-slate-200 p-4">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="rounded border border-slate-200 px-3 py-2 text-lg font-medium outline-none focus:border-brand"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write something…"
          className="flex-1 resize-none rounded border border-slate-200 p-3 outline-none focus:border-brand"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            className="rounded bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            {id ? "Update" : "Save"}
          </button>
          <button
            type="button"
            onClick={blank}
            className="rounded border border-slate-200 px-4 py-2 text-sm hover:bg-slate-100"
          >
            Clear
          </button>
        </div>
      </section>
    </div>
  );
}
