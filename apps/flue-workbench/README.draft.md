<!--
  README.draft.md — produced by /grill-module. Follows the published README
  format in `.claude/rules.md` § "README Files". Sections starting as TBD
  fill in as the grill session resolves them. On promotion to README.md:
  rename this file and strip the `<!-- DRAFT ONLY -->` block at the bottom.

  Source sketch: notes/2026-05/2026-05-21/flue-isomorphic-adoption-sketch.md
-->

# flue-workbench

## What it is

A browser-first application that lets a user point a Flue agent at a local directory and chat with it through an xterm-based terminal. The user picks a workspace folder (via `showDirectoryPicker`), the app discovers or prompts for a Gemini API key, then runs an isomorphic Flue runtime in the same tab — every `read`/`write`/`edit`/`bash`/`grep`/`glob`/`task` tool the model invokes operates on the picked directory through `FilesApi`. The terminal the user types into runs a second `Bash` instance over the same filesystem; the `agent <prompt>` command streams Gemini's response back into xterm.

The app ships with a self-contained integration library at `apps/flue-workbench/src/lib/` (logical package: `flue-workbench`). That library is the only thing a future second consumer (e.g. a Node demo or an embed in `chat.app`) would import; the rest of the app is Vite glue and React UI.

## Why it exists

Two motivations:

1. **Validate the isomorphic-Flue hypothesis end-to-end.** The companion sketch (`flue-isomorphic-adoption-sketch.md`) argues that Flue can run unchanged in Node and the browser by wrapping `@statewalker/webrun-files`'s `FilesApi` as a `just-bash` filesystem and a Flue `SessionEnv`. This app is the first surface that actually proves the wiring works against a real LLM call.
2. **Have a usable workbench for poking at Gemini against a local directory.** Today the only path is `chat.app` (Vercel AI SDK, `@statewalker/ai-agent`) or one of the webrun-wire site-builder demos — neither of which is a "drop me into a folder and let me talk to a model" tool. Flue's `read`/`edit`/`grep`/`task` toolset is exactly that, and Gemini's free tier makes it cheap to iterate.

What it explicitly does *not* replace: `chat.app`, `@statewalker/ai-agent`, or the production agent runtime in `statewalker-apps`. This is a sandbox-tier workbench, hosted in `statewalker-sandbox`, until the design proves itself.

## How to use

The library at `src/lib/` exposes two layers:

- A **convenience factory** — `createWorkbench(opts)` — composes everything with defaults. Use this in the app entry.
- **Piecewise factories** — `buildFilesViews`, `FilesApiSecretStore`, `FilesApiSessionStore`, `filesApiBashFactory`, `buildBash`, `mountXtermTerminal`, `newAgentCommand`, `newSecretCommand`, `newSessionCommand`. Use these to compose a workbench with non-default wiring (e.g. a custom secret prompt UI, an alternate terminal emulator, a different default model).

The convenience factory is the canonical entry; piecewise exports are documented but the surface is owned by `createWorkbench` for v1 — see `## Internals` for the drift-risk note.

Boot sequence:

1. User clicks "Pick workspace" → `showDirectoryPicker()` resolves a `FileSystemDirectoryHandle` (persisted to IndexedDB so reload re-opens the same folder, modulo permission re-prompt).
2. Wrap the handle in `BrowserFilesApi` from `@statewalker/webrun-files-browser` → that's the `rootFiles`.
3. The host mounts an xterm into the DOM and passes it (as anything implementing the four-method `Terminal` contract) into `createWorkbench`.
4. `await createWorkbench({ rootFiles, terminal, onSecretRequest })` runs synchronously up to the point where it needs `GEMINI_API_KEY`. If the key is missing in `/.settings/secrets.json`, it calls `onSecretRequest('GEMINI_API_KEY')` — the host shows a modal, the user pastes the key, the modal resolves the promise. The workbench then writes through `FilesApiSecretStore`, initialises the Flue harness, attaches the input-handler to the terminal, and only *then* resolves the `Workbench` value to the caller.
5. The resolved `Workbench` exposes `{ session, secrets, runShell, dispose }` for programmatic use. The terminal is already interactive — typing `agent <prompt>` streams Gemini's response back; Ctrl-C aborts the in-flight call.
6. If `onSecretRequest` rejects (user dismissed), `createWorkbench` rejects with `WorkbenchSecretMissingError` and no `Workbench` is exposed — the host renders a "key required" screen and the user retries.

## Examples

### Minimal usage

```ts
// apps/flue-workbench/src/main.ts
import "@xterm/xterm/css/xterm.css";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";

import { createWorkbench } from "./lib/index.js";
import { askGeminiKey } from "./ui/ask-gemini-key.js";   // React modal

// 1. Browser-only: showDirectoryPicker, persist handle in IndexedDB.
const rootHandle = await pickOrResumeWorkspace();
const rootFiles = new BrowserFilesApi({ rootHandle });

// 2. xterm in #term, fit to container.
const xt = new Xterm({ cursorBlink: true, convertEol: true });
const fit = new FitAddon();
xt.loadAddon(fit);
xt.open(document.getElementById("term")!);
fit.fit();

// 3. Wire workbench. onSecretRequest gates the harness on a key being present.
const workbench = await createWorkbench({
  rootFiles,
  terminal: xt,                              // anything implementing {write,writeln,clear,onData}
  defaultModel: "google/gemini-2.5-flash",
  onSecretRequest: async (name) => {
    if (name !== "GEMINI_API_KEY") throw new Error(`unknown secret: ${name}`);
    return askGeminiKey();                   // React modal → Promise<string>
  },
});

// 4. Terminal is live; `agent <prompt>` streams responses.
//    No further code needed; the workbench owns the input loop.
```

### Failure / edge path

```ts
// User picked a folder but denied permission on reload, OR clicked Cancel.
try {
  const rootHandle = await pickOrResumeWorkspace();
  // …
} catch (err) {
  if (err instanceof DOMException && err.name === "AbortError") {
    // User cancelled the picker. Render the "Pick workspace" landing again.
    return showLanding({ reason: "cancelled" });
  }
  throw err;
}

// User dismissed the secrets modal — askGeminiKey() throws.
// createWorkbench rejects with WorkbenchSecretMissingError (no partial Workbench).
try {
  await createWorkbench({ /* … */ });
} catch (err) {
  if (err instanceof WorkbenchSecretMissingError) {
    // Render a "Gemini key required" landing with a "Try again" button
    // that re-runs createWorkbench. The terminal is NOT live until a
    // workbench resolves — boot gating is atomic.
    return showLanding({ reason: "key-required" });
  }
  throw err;
}

// In-flight agent call cancelled with Ctrl-C.
// Terminal sends \x03 → workbench's AbortController fires →
// session.prompt rejects with AbortError → terminal writes "[aborted]".
```

## Internals

TBD — populated during implementation. Open shape:

- `src/lib/files-api-adapter.ts` — `FilesApiAdapter` per sketch §2: just-bash `FileSystem` shape over `FilesApi`.
- `src/lib/build-files-views.ts` — `buildFilesViews(rootFiles) → {rootFiles, systemFiles, userFiles}` per sketch §6, using `FilteredFilesApi` from `@statewalker/webrun-files-composite`.
- `src/lib/files-api-secret-store.ts` — `FilesApiSecretStore` per sketch §5, backed by `/.settings/secrets.json` on the system view.
- `src/lib/files-api-session-store.ts` — `FilesApiSessionStore` per sketch §4, backed by `/.settings/sessions/` on the system view, session id = `workbench/<workspace-key>/main`.
- `src/lib/bash-factory.ts` — `filesApiBashFactory(opts)` per sketch §3: returns a Flue `BashFactory` that constructs a `Bash` (from `just-bash/browser`) over the shared `FilesApiAdapter`.
- `src/lib/build-bash.ts` — `buildBash(opts)` per sketch §7: creates the `@just-bash/executor` and returns `{ executor, factory }`. Wires Flue tools as both `js-exec` tools and kebab-case bash commands.
- `src/lib/agent-command.ts` — `newAgentCommand({ session, term })` per sketch §9.5: `defineCommand` that subscribes to the run's event stream and writes deltas to the `Terminal`. Handles Ctrl-C via `AbortController`.
- `src/lib/static-commands.ts` — `newSecretCommand`, `newSessionCommand` per sketch §8. **Only registered on the human-facing Bash**, not on the model-facing Bash. (`clear` is handled inside `input-handler.ts` directly per sketch §9.4, not as a `defineCommand`.)
- `src/lib/errors.ts` — `WorkbenchSecretMissingError` (thrown from `createWorkbench` when `onSecretRequest` rejects) and any other typed errors the library promises.
- `src/lib/mount-xterm.ts` — sketch §9.3 verbatim: bind xterm to the minimal `Terminal` contract, mount addons.
- `src/lib/terminal-contract.ts` — the four-method `Terminal` interface (`write/writeln/clear/onData`) borrowed from the just-bash example.
- `src/lib/input-handler.ts` — ported from `just-bash`'s `examples/website/terminal-parts/input-handler.ts`, with the streaming-exec change called out in sketch §9.4.
- `src/lib/create-workbench.ts` — the convenience factory; composes all of the above with default choices.

### Constraints

- **Browser support**: Chromium-family only (Chrome / Edge / Opera / Arc). The app uses `window.showDirectoryPicker()` for workspace selection; Firefox and Safari render an "unsupported browser" page. No OPFS fallback in v1 — adding it doubles the UX surface without solving the "talk to a model about my repo" story.
- **Workspace handle lifetime**: the picked `FileSystemDirectoryHandle` is persisted in IndexedDB so reload re-opens the same directory. The browser still re-prompts for permission on every reload; the user has to click "Allow" each session. We cache nothing more than the handle itself.
- **Secrets live inside the workspace**. `/.settings/secrets.json` is written into the picked folder (hidden from the model via `FilteredFilesApi`, never via `userFiles`). The app shows a banner urging the user to add `/.settings/` to `.gitignore`. This is the sketch §6 design — a deliberate choice over IndexedDB-only secrets, but the leak surface is real.
- **Single-provider v1**: `google/gemini-2.5-flash` is the only configured provider. Multi-provider support (Anthropic / OpenAI) is deferred — the secret store can carry multiple keys, but only `GEMINI_API_KEY` is read at boot.
- **Single-session per workspace**: `session id = workbench/<workspace-key>/main`. No multi-session UI. `session reset` (human-terminal command) wipes the persisted session and starts fresh.
- **No node-tagged code in `src/lib/`**. The library is Vite-buildable for the browser target with no `node:*` imports. The app's optional Node demo (if/when it lands) lives outside `src/lib/`.
- **API surface drift risk**: both `createWorkbench` and the piecewise factories are exported. `createWorkbench` is the canonical surface; piecewise exports exist for power users but are subject to incompatible change. Anyone reaching past `createWorkbench` is consenting to track internal moves.

### Dependencies

- `@flue/runtime` (specifically `@flue/runtime/internal` + `@flue/runtime/sandbox`) — the agent loop.
- `@earendil-works/pi-ai` — provider registry; required by `@flue/runtime`. Used at boot to register or look up the Gemini provider.
- `just-bash` (browser entry: `just-bash/browser`) — the shell. Both the model's bash tool and the human-facing terminal use it.
- `@just-bash/executor` — wires Flue tools as bash commands + js-exec tools (sketch §7).
- `@statewalker/webrun-files` — the `FilesApi` abstraction the adapter wraps.
- `@statewalker/webrun-files-browser` — `BrowserFilesApi` over `FileSystemDirectoryHandle`. App-facing only.
- `@statewalker/webrun-files-mem` — `MemFilesApi`. Used in tests; can be re-exported for opt-in app demos.
- `@statewalker/webrun-files-composite` — `FilteredFilesApi`, the system/user view split.
- `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` — terminal emulator (sketch §9). LiteTerminal swap-in is documented but not shipped in v1.

The library has **no React dependency**; the host app provides React for the secrets modal and chrome. `src/lib/` is plain TS/ESM and depends only on the bundles above.

## License

MIT © statewalker

<!-- DRAFT ONLY — strip before promotion to README.md -->

## Test Goals

High-level testable contracts. Formal `Requirement: / Scenario:` blocks live in
`openspec/changes/<name>/specs/<name>/spec.md`, generated from this list by
`/opsx:propose`.

- **FS-adapter parity** — a `Bash` instance constructed with `FilesApiAdapter` over a `MemFilesApi` can execute `ls`/`cat`/`echo`/`mkdir`/`rm` over an arbitrary directory tree with output equivalent to a `Bash` instance constructed with `just-bash`'s built-in `InMemoryFs` against the same seed tree.
- **System / user view isolation** — anything written under `/.settings/` via the system view is invisible to `userFiles.list / read / stat / exists`. The model's `read` tool, even given a literal path to `/.settings/secrets.json`, cannot reach the bytes.
- **Secret round-trip** — `FilesApiSecretStore.set(key, value)` followed by `get(key)` returns the same value, both within a store instance and after re-instantiating the store against the same `FilesApi`.
- **Boot gating** — `createWorkbench` does not resolve a `Workbench` until either (a) `GEMINI_API_KEY` is already present in `/.settings/secrets.json`, or (b) `onSecretRequest('GEMINI_API_KEY')` resolves with a value that is then persisted. If `onSecretRequest` rejects, `createWorkbench` rejects with `WorkbenchSecretMissingError`; no partially-initialised state is exposed.
- **Session resume** — closing and re-opening a `Workbench` against the same `rootFiles` produces a session whose history begins with the previous session's last turn (verified via `harness.session().messages()` or equivalent introspection).
- **Streaming bridge** — invoking `agent <prompt>` writes text deltas to the `Terminal` as they arrive, before `session.prompt` resolves. (Verified by asserting that the terminal received characters while the run was still in flight.)
- **Cancellation** — sending `\x03` (Ctrl-C) on `Terminal.onData` while `agent` is running aborts the in-flight `session.prompt`; the `agent` command returns exit code 130; the terminal remains usable for further input.
- **Two-bash / one FS** — a file write performed by the model via its `write` tool is visible to `ls` typed into the human terminal in the same tick (same `FilesApiAdapter`, no caching layer between the two `Bash` instances).
- **Isomorphism smoke** — the same library composition driven by a `MemFilesApi` (in Vitest) and by a `BrowserFilesApi` (in the running app) supports the same end-to-end flow: rootFiles → set `GEMINI_API_KEY` → prompt that creates `/workspace/out.txt` → assert the file exists and the conversation persisted.

<!-- END DRAFT ONLY -->
