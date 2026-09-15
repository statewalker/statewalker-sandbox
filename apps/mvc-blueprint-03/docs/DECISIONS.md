# Decisions

### D1 — Slots carry what the UI shows; commands are calls between domains
01 shows views as `ui:*` commands a view adapter claims. Here a view model is contributed to an
extension point and withdrawn by its disposer, as in 02. Commands remain for `todos:edit:open`,
`todos:clear-completed:ask`, `notifications:notify` (required) and `todos:changed` (a silent broadcast).

### D2 — Models are interfaces; implementations are separate modules
`*.model.ts` holds interfaces and view kinds; `*.model.impl.ts` builds instances on signals. The UI
imports only the interfaces, so the substrate can change without touching a renderer.

### D3 — Intents are ActionModels without payloads
Data lives in data models (selection, draft); an action only says "do it". One type serves toolbar
buttons, menu items, row buttons and dialog answers, and carries label, icon, hint, enabled and running.

### D4 — Enablement that follows data is derived in the model implementation
A controller runs a microtask later than a gesture. If it computed `enabled`, a gesture that selects a
row and submits in the same tick would be ignored. `createAction({ when })` derives it synchronously;
the controller sets only `running`, and may force `enabled: false`.

### D5 — Actions are extension points too
The list contributes its actions to `actions:todos.toolbar` and `actions:todos.selection`; `ActionBar` and
`ActionMenu` render whatever is contributed, so another domain can add a menu item without touching
the list. A row's own buttons bypass the slot and call the list's own actions directly — the
indirection only matters for a cross-domain contribution. `ActionMenu` has no trigger element of its
own to return focus to when it closes, so it remembers what had focus when it opened and restores that
instead — the same approach the host uses for a contributed dialog. This replaces 01's menu built from
command declarations.

### D6 — Organised by domain; the UI tree mirrors it
A domain folder holds its models, implementations, commands and controller. Cross-domain imports are
limited to `…/model`, `…/commands`, `@todos/core` and `@todos/events`; only the composition root imports
a domain's index.

### D7 — Services on the context; the todo api called directly
The todo api, the buses and the logger come from app-context adapters. 01's `todos:*` command surface is
dropped: nothing else needs to intercept those calls here.

### D8 — Every disposal through a registry
`newRegistry()` everywhere. Because its cleanup is async, models guard synchronously with a flag and an
`alive` signal before releasing. The UI host may use the registry: it is a disposal utility, not a
service or a bus.

### D9 — A submit listener only captures; the pass acts on what it captured
Every action's `onSubmitsUpdate` listener is read-only — it snapshots what the intent means at that
instant (the list's selection, items and new-title draft; the edit form's baseline todo and draft) and kicks
the update loop, rather than letting the pass reread the model once its microtask runs. A selection or
a draft the user changes before the pass reaches it must not retarget an already-submitted intent, and
a Toggle or Delete submitted over an empty selection does nothing rather than acting on whatever is
selected later. For the same reason, an edit session's open and close are serialised: an open waits for
any close still in flight before it registers a new panel, so two opens never race for the same panel
id, and a Save that has already reached the api is broadcast, logged and toasted even if its editor
was replaced meanwhile — unless the controller has been disposed, since a disposed controller issues
no command — while only the bookkeeping that assumes the session is still current
(clearing `running`, marking the form saved) is skipped once it is not. Clear-completed broadcasts
`todos:changed` on the same principle: whenever at least one todo was actually removed, even if the
rest of the pass then fails. Its question is a snapshot too: the ids of the todos done when it was
asked, which OK removes — never whatever is done by the time OK runs.

## Out of scope

Tracing and log-derived statistics (02); a plain-DOM host; persistence; unsaved-changes prompts;
keyboard shortcuts; selection gestures beyond click and Ctrl-click; undo; an error model.
