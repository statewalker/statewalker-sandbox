import type { Note, NoteStore } from "./store.js";

/** Stable id for a fresh note (no crypto dependency needed). */
const newId = () => `n-${Date.now().toString(36)}`;

const h = (tag: string, cls: string, text?: string): HTMLElement => {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

/**
 * A vanilla-DOM note-taking UI (no framework — the demo showcases the no-bundle
 * webrun-modules pipeline + its CSS features, not a UI library). Tailwind utility
 * classes come from the Tailwind entry (styles.css); `.note-card` comes from the
 * plain `@import` chain (theme.css → palette.css, F2 runtime); `.logo` (a url()
 * asset, F3) comes from tokens.css.
 */
export function mountApp(root: HTMLElement, store: NoteStore, onChange?: () => void): void {
  let notes: Note[] = [];
  let selected: string | null = null;

  root.className = "flex h-screen bg-slate-50 text-slate-800";
  const aside = h("aside", "w-64 shrink-0 border-r border-slate-200 bg-white flex flex-col");
  const main = h("main", "flex-1 flex flex-col");
  root.replaceChildren(aside, main);

  async function refresh() {
    notes = await store.listNotes();
    renderList();
    renderEditor();
    onChange?.();
  }

  function renderList() {
    const head = h("div", "flex items-center gap-2 p-4 border-b border-slate-200");
    head.append(h("span", "logo w-6 h-6 rounded bg-brand"), h("h1", "font-semibold", "Notes"));
    const add = h("button", "ml-auto rounded bg-brand px-2 py-1 text-sm text-white", "+ New");
    add.onclick = async () => {
      const note: Note = { id: newId(), title: "Untitled", body: "" };
      await store.saveNote(note);
      selected = note.id;
      await refresh();
    };
    head.append(add);

    const list = h("ul", "flex-1 overflow-y-auto p-2 flex flex-col gap-2");
    for (const n of notes) {
      const item = h("li", `note-card cursor-pointer rounded p-3 ${n.id === selected ? "bg-brand/10" : "bg-white hover:bg-slate-100"}`);
      item.append(h("div", "font-medium truncate", n.title || "Untitled"));
      item.append(h("div", "text-xs text-slate-500 truncate", n.body || "No content"));
      item.onclick = () => {
        selected = n.id;
        renderList();
        renderEditor();
      };
      list.append(item);
    }
    aside.replaceChildren(head, list);
  }

  function renderEditor() {
    const note = notes.find((n) => n.id === selected);
    if (!note) {
      main.replaceChildren(h("div", "m-auto text-slate-400", "Select or create a note"));
      return;
    }
    const bar = h("div", "flex items-center gap-2 p-4 border-b border-slate-200");
    const title = h("input", "flex-1 text-lg font-semibold outline-none") as HTMLInputElement;
    title.value = note.title;
    const del = h("button", "rounded border border-slate-300 px-2 py-1 text-sm text-red-600", "Delete");
    del.onclick = async () => {
      await store.deleteNote(note.id);
      selected = null;
      await refresh();
    };
    bar.append(title, del);

    const body = h("textarea", "flex-1 resize-none p-4 outline-none") as HTMLTextAreaElement;
    body.value = note.body;
    const save = async () => {
      note.title = title.value;
      note.body = body.value;
      await store.saveNote(note);
      renderList();
      onChange?.();
    };
    title.onblur = save;
    body.onblur = save;

    main.replaceChildren(bar, body);
  }

  void refresh();
}
