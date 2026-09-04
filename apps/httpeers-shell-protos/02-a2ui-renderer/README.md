# 02 — A JSON spec renders against a catalogue

`pnpm test 02-a2ui-renderer`

**Question**: can a JSON spec render into one DOM root against a catalogue?

**Answer: yes.** The A2UI v0.9.1 adjacency-list model renders correctly, and
the catalogue genuinely constrains what may be sent — not by policy, by
construction.

This was the riskiest rung. A2UI was adopted before a line had been written
against it, and two earlier claims about the protocol turned out to be wrong
(A2UI is at v0.9/v0.9.1, not v1.0 — v1.0 was A2A, a different protocol; and
v0.8's `beginRendering`/`surfaceUpdate` were renamed to
`createSurface`/`updateComponents` in v0.9). The rung was moved to the front
for exactly that reason.

Tests run against the **consolidated** `lib/` renderer, not the rung-2 copy
in `19-prototype-02-a2ui-renderer.tar.gz`. `render.test.ts` is recovered from
that archive; only the import paths and one assertion changed — see
"The one archived test that did not survive" below.

## Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | A surface renders nothing until components arrive | `createSurface` alone leaves `root.textContent` empty | An empty surface paints something |
| 2 | A single `Text` at `id: "root"` renders | Root found by convention, not by a pointer in the message | The root has to be named explicitly |
| 3 | Components for an unknown surface are refused | `updateComponents` for a surface never created throws `Unknown surface` | A surface is created implicitly by an update |
| 4 | `deleteSurface` removes the host element | Text is gone from `root` afterwards | The host element leaks |
| 5 | The tree is built from **id references**, not nesting | `Column` naming `["title","body"]` produces `h1` + text | Children have to be inlined |
| 6 | Components may arrive in **any order** | Leaf sent first, root last, renders identically | The renderer depends on topological order |
| 7 | Update is **incremental** | Re-sending only `b` changes `b` and leaves `a` alone | The whole tree must be re-sent per change |
| 8 | A **dangling** child reference throws | `children: ["missing"]` throws rather than rendering a hole | A missing id degrades silently |
| 9 | A **reference cycle** is detected | Mutually-referencing `Column`s throw `cycle` | Stack overflow — an error a malicious peer could trigger deliberately |
| 10 | A component **outside the catalogue** is rejected, naming the catalogue | `ScriptTag` throws `not in catalogue <catalogId>` | Any component name renders |
| 11 | A **missing required property** is rejected | `Text` with no `text` throws, naming `text` | Required props are advisory |
| 12 | An unsupported `catalogId` is rejected at `createSurface` | A foreign catalogue URI throws | The renderer renders against a catalogue it does not implement |
| 13 | Text **never becomes markup** | `<img src=x onerror=alert(1)>` renders as visible text; `querySelector("img")` is null | `innerHTML` anywhere on the text path |
| 14 | `Button` renders its label child and its Basecoat class | `button.textContent === "OK"`, `className === "btn"`, no `data-variant` for `primary` | See the note below |
| 15 | `Row`, `Divider` and `TextField` render | `input` and `hr` both present | A catalogue component has no element factory |
| 16 | The catalogue is **data** | `JSON.stringify(shellCatalog)` does not throw; `catalogId` is an `https:` URI | The catalogue cannot be published at its own URI or negotiated with a peer |

## Why the catalogue is the security boundary

A2UI's own guidance is that production applications define their own
catalogue rather than using the eighteen-component basic one. For httpeers the
argument is stronger than design consistency.

**A peer-served surface is a foreign application's output.** The catalogue is
the complete enumeration of what that foreign output is permitted to express.
Six components: `Text`, `Column`, `Row`, `Divider`, `Button`, `TextField`.
Anything absent cannot be rendered — not because a rule forbids it, but
because no code exists that would build it. That is the structural-enforcement
principle applied to UI, and rows 10–13 are what hold it up.

Two supporting properties come from the same reading:

- **Validate before mutate.** A whole `updateComponents` batch is validated
  before any of it is stored, so a bad batch cannot leave a surface
  half-updated. This matters more here than in a typical renderer, because the
  batch may come from a peer whose correctness is not guaranteed.
- **Actions are declared by name.** `{"action": {"event": {"name": "confirm"}}}`
  is a *request*; the shell decides what, if anything, it maps to. Rung 2
  records the name and attaches no handler at all — rendering an action and
  honouring it are separate concerns, and only the second needs the shell's
  trust. Dispatch is rung 3.

## The one archived test that did not survive

Fifteen of the sixteen archived assertions passed against `lib/` unchanged.
One failed:

```
× shell components > renders a button with its label child
  expected null to be 'primary'
```

**Verdict: the test is stale; `lib/` is right.** Rung 2's own renderer echoed
the message's variant string verbatim onto the element —
`if (c["variant"]) el.setAttribute("data-variant", String(c["variant"]))` —
so `variant: "primary"` produced `data-variant="primary"`, and the assertion
was true of the code it was written against. Rung 7 then measured Basecoat 1.0
and found that a bare `.btn` **is** the primary button; `data-variant` selects
only a non-default variant. `lib/basecoat.ts` therefore maps
`primary → undefined`, meaning *omit the attribute* (note 32 §1):

| Catalogue variant | Basecoat expression |
|---|---|
| `primary` | `class="btn"`, attribute **omitted** |
| `secondary` | `class="btn" data-variant="secondary"` |
| `danger` | `class="btn" data-variant="destructive"` |

The assertion was corrected in place to the live contract, with the history
kept at its site. This is the same drift consolidation caught in the 6b copy
(`lib/ORIGIN.md`, "Why consolidation happened"): a stale test in an isolated
copy is invisible and becomes a failure the moment the copies meet.

It is also a small improvement in the security story. Rung 2 copied an
attribute value out of a peer's message onto an element; the enum check kept
it to three known values, but the value's *origin* was the message. In `lib/`
the attribute value originates in the mapping table and nowhere else, which is
the same rule that governs class names.

## Not covered here

- **No data binding, no `updateDataModel`, no action dispatch** — rung 3.
- **No theming.** `createSurface` accepts a `theme` and ignores it; honouring a
  peer-supplied theme is a security question, not only a design one.
- **No Basecoat mapping tests.** Rows 14's class assertions are incidental;
  the mapping itself is rung 6b's subject.
- **No multi-surface coordination**, no dock layout, no panes — rung 7.
- **No transport.** Messages are handed to `handle()` directly.
- **No catalogue negotiation.** Exactly one `catalogId` is accepted; the
  client-capabilities envelope and v0.9's dynamic catalogues are unexplored.
- **No conformance testing** against the official `standard_catalog.json` or
  the envelope schemas. Message shapes follow the published documentation.
- **Full repaint.** Rung 2 repaints the whole surface on update, which destroys
  focus. Invisible with static text, fatal once a `TextField` is bound — and
  the reason rung 3 exists. `lib/` no longer behaves this way, so the tests
  here pass against a renderer that is strictly better than the one they were
  written for.
