# shell-core — the live consolidated code

_2 September 2026_

**This is the current code.** The prototype archives in the parent folder
(items 09, 13, 14, 17, 19, 21, 26, 27, 28) are historical records of each
rung and contain **superseded** copies of the renderer. Read those for how a
finding was reached; read this for what the code actually is.

## Files

| File | Origin | What it is |
|---|---|---|
| `catalog.ts` | rung 2 | The A2UI catalogue: six components. The security boundary — a peer-served surface may express these and nothing else. |
| `renderer.ts` | rungs 2, 3, 6b, 7 | The A2UI renderer: validation, keyed reconciliation, data binding, action dispatch, Basecoat classes. |
| `basecoat.ts` | rung 6b, corrected in 7 | Catalogue-to-Basecoat mapping. Classes originate here and never in a message. |
| `dock.ts` | rungs 7, 7a | Dockview integration and layout persistence. |

Tests (in the local archive, not uploaded individually): `binding.test.ts`,
`basecoat.test.ts`, `layout.test.ts` — **36 tests, all passing**, typecheck
clean.

## Why consolidation happened

The renderer had been copied three times, and the render-key fix and the
`data-variant` fix ended up in different copies. Merging them immediately
exposed a stale test in the 6b copy that asserted a model rung 7 had already
disproved. A wrong test in an isolated copy is invisible; it becomes a
failure the moment the copies meet.

## The findings embedded in this code

Each is a comment at its site, but collected here because they are the
expensive part:

1. **`replaceChildren` blurs the active element** even when passed identical
   element instances — it detaches and reattaches every child. Element
   identity is necessary but not sufficient for focus. Diff the child list
   and only touch the DOM when it differs.
2. **Never write `input.value` when that input is `document.activeElement`.**
3. **The render key must include any property that affects element identity**,
   not just the component name. `Text`'s variant selects the tag.
4. **Basecoat 1.0 uses `data-variant` attributes, not variant classes.**
   `btn-secondary` does not exist outside the legacy compat stylesheet.
5. **The prebuilt Basecoat bundle contains no Tailwind utilities**, so layout
   uses shell-owned classes (`shell-col`, `shell-row`, `shell-field`) to
   keep the zero-build path.
6. **Dockview's `IContentRenderer` requires the component to own its
   `element`** — the documented `params.containerElement` is wrong for v8.
7. **Dockview's CSS is embedded in the JS as a string and never injected**,
   and **the theme class must be applied to the host by hand**.
8. **Identity persists, content does not.** A layout stores `origin` only;
   surfaces are re-requested from their peer, never resurrected from storage.

## Known holes

- A **binding bypasses enum validation** — it may resolve to a value the
  catalogue forbids.
- Reconciliation is **O(tree) per update**, with no path-to-component
  dependency map. Fine for dialogs, wrong for lists.
- `theme` on `createSurface` is accepted and ignored. Honouring a
  peer-supplied theme is a security question.
- No `watchDataModel` modes, so the client reports on every input event.
- Action names have no namespace and could collide between apps.
- Nothing versions the layout format.
