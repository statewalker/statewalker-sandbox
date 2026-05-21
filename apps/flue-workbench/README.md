# flue-workbench

## What it is

A browser-first application that lets a user point a Flue agent at a local directory and chat with it through an xterm-based terminal. The user picks a workspace folder (via `showDirectoryPicker`), the app discovers or prompts for a Gemini API key, then runs an isomorphic Flue runtime in the same tab — every `read`/`write`/`edit`/`bash`/`grep`/`glob`/`task` tool the model invokes operates on the picked directory through `FilesApi`. The terminal the user types into runs a second `Bash` instance over the same filesystem; the `agent <prompt>` command streams Gemini's response back into xterm.

The app ships with a self-contained integration library at `apps/flue-workbench/src/lib/` (logical package: `flue-workbench`). That library is the only thing a future second consumer (e.g. a Node demo or an embed in `chat.app`) would import; the rest of the app is Vite glue and React UI.

## Why it exists

Two motivations:

1. **Validate the isomorphic-Flue hypothesis end-to-end.** The companion sketch (`notes/2026-05/2026-05-21/flue-isomorphic-adoption-sketch.md`) argues that Flue can run unchanged in Node and the browser by wrapping `@statewalker/webrun-files`'s `FilesApi` as a `just-bash` filesystem and a Flue `SessionEnv`. This app is the first surface that actually proves the wiring works against a real LLM call.
2. **Have a usable workbench for poking at Gemini against a local directory.** Today the only path is `chat.app` (Vercel AI SDK, `@statewalker/ai-agent`) or one of the webrun-wire site-builder demos — neither of which is a "drop me into a folder and let me talk to a model" tool. Flue's `read`/`edit`/`grep`/`task` toolset is exactly that, and Gemini's free tier makes it cheap to iterate.

What it explicitly does *not* replace: `chat.app`, `@statewalker/ai-agent`, or the production agent runtime in `statewalker-apps`. This is a sandbox-tier workbench, hosted in `statewalker-sandbox`, until the design proves itself.

## How to use

The library at `src/lib/` exposes two layers:

- A **convenience factory** — `createWorkbench(opts)` — composes everything with defaults. Use this in the app entry.
- **Piecewise factories** — `buildFilesViews`, `FilesApiSecretStore`, `FilesApiSessionStore`, `filesApiBashFactory`, `buildBash`, `mountXtermTerminal`, `newAgentCommand`, `newSecretCommand`, `newSessionCommand`, `gateSecret`, `configureGemini`. Use these to compose a workbench with non-default wiring (e.g. a custom secret prompt UI, an alternate terminal emulator, a different default model).

The convenience factory is the canonical entry; piecewise exports are documented but the surface is owned by `createWorkbench` for v1 — see `## Internals` for the drift-risk note.

Boot sequence:

1. User clicks "Pick workspace" → `showDirectoryPicker()` resolves a `FileSystemDirectoryHandle` (persisted to IndexedDB so reload re-opens the same folder, modulo permission re-prompt).
2. Wrap the handle in `BrowserFilesApi` from `@statewalker/webrun-files-browser` → that's the `rootFiles`.
3. The host mounts an xterm into the DOM and passes it (as anything implementing the four-method `Terminal` contract) into `createWorkbench`.
4. `await createWorkbench({ rootFiles, workspaceKey, terminal, onSecretRequest })` runs synchronously up to the point where it needs `GEMINI_API_KEY`. If the key is missing in `/.settings/secrets.json`, it calls `onSecretRequest('GEMINI_API_KEY')` — the host shows a modal, the user pastes the key, the modal resolves the promise. The workbench then writes through `FilesApiSecretStore`, configures the pi-ai Google provider, initialises the Flue harness, attaches a terminal input loop, and only *then* resolves the `Workbench` value to the caller.
5. The resolved `Workbench` exposes `{ session, harness, secrets, sessions, views, sessionId, runShell, dispose }` for programmatic use. The terminal is already interactive — typing `agent <prompt>` streams Gemini's response back; Ctrl-C aborts the in-flight call.
6. If `onSecretRequest` rejects (user dismissed), `createWorkbench` rejects with `WorkbenchSecretMissingError` and no `Workbench` is exposed — the host renders a "key required" screen and the user retries.

## Examples

### Minimal usage

```ts
// apps/flue-workbench/src/main.tsx
import { createRoot } from "react-dom/client";
import {
  createWorkbench,
  mountXtermTerminal,
  WorkbenchSecretMissingError,
} from "./lib/index.js";
import { openOrResumeWorkspace } from "./lib-host/workspace-handle-store.js";
import { askGeminiKey } from "./ui/ask-gemini-key.js";   // React modal

const { files, workspaceKey } = await openOrResumeWorkspace();
const mounted = mountXtermTerminal({
  container: document.getElementById("term")!,
  banner: (t) => t.writeln("\x1b[36mflue-workbench> ready. try: agent \"hello\"\x1b[0m"),
});

const workbench = await createWorkbench({
  rootFiles: files,
  workspaceKey,
  terminal: mounted.term,
  onSecretRequest: askGeminiKey,
});

// Terminal is live; `agent <prompt>` streams responses.
// No further code needed; createWorkbench owns the input loop.
```

### Failure / edge path

```ts
try {
  const { files, workspaceKey } = await openOrResumeWorkspace();
  // ...
} catch (err) {
  if (err instanceof DOMException && err.name === "AbortError") {
    // User cancelled the picker. Render the "Pick workspace" landing again.
    return renderLanding({ reason: "cancelled" });
  }
  throw err;
}

try {
  await createWorkbench({ /* ... */ });
} catch (err) {
  if (err instanceof WorkbenchSecretMissingError) {
    // The host renders a "Gemini key required" landing with a "Try again"
    // button that re-runs createWorkbench. The terminal is NOT live until
    // a workbench resolves — boot gating is atomic.
    return renderLanding({ reason: "key-required" });
  }
  throw err;
}

// In-flight agent call cancelled with Ctrl-C.
// Terminal sends \x03 → workbench's AbortController fires →
// session.prompt rejects with AbortError → command exits 130 (SIGINT).
```

## Internals

Library files under `src/lib/`:

- `terminal-contract.ts` — the four-method `Terminal` interface (`write/writeln/clear/onData`).
- `errors.ts` — `WorkbenchSecretMissingError` with a stable `name` and `secretName` field.
- `files-api-adapter.ts` — `FilesApiAdapter` implementing just-bash's `IFileSystem` over `FilesApi`. ENOSYS stubs for operations FilesApi doesn't model (`chmod`/`symlink`/`link`/`readlink`/`utimes`).
- `build-files-views.ts` — `buildFilesViews(rootFiles) → {rootFiles, systemFiles, userFiles}` using `FilteredFilesApi` from `@statewalker/webrun-files-composite`. System view's predicate exposes `/` so listing can enumerate `.settings` as a child.
- `files-api-secret-store.ts` — `FilesApiSecretStore` over a JSON file at `/.settings/secrets.json`.
- `files-api-session-store.ts` — `FilesApiSessionStore` implementing Flue's `SessionStore` interface. Hex-encodes the session id for the filename.
- `session-id.ts` — `workbenchSessionId(workspaceKey) → 'workbench/<key>/main'`.
- `gate-secret.ts` — extracted boot gate. Pure unit-testable helper that returns the existing value or prompts via `onSecretRequest`, persists, and returns; throws `WorkbenchSecretMissingError` atomically on rejection or empty.
- `configure-gemini.ts` — patches the pi-ai Google provider via `configureProvider("google", { apiKey })`. pi-ai ships a native `./google` subpath export, so no OpenAI-compat shim is needed.
- `bash-factory.ts` — `filesApiBashFactory(opts)` returns a Flue `BashFactory` that constructs a `Bash` over `FilesApiAdapter`.
- `build-bash.ts` — `buildBash(opts)` wires `@just-bash/executor` to expose Flue tools as both `js-exec` tools and namespace-prefixed kebab-case bash commands.
- `agent-command.ts` — `newAgentCommand({ session, subscribeEvent, term })`. Subscribes to the run's `FlueEvent` stream and writes `text_delta` (CR-LF normalised), `tool_start` (dimmed `[name]`), `thinking_start` to the `Terminal`. Returns exit code 130 on AbortError; subscription cleaned up in finally.
- `static-commands.ts` — `newSecretCommand`, `newSessionCommand`. **Only registered on the human-facing `Bash`**, not on the model-facing one.
- `mount-xterm.ts` — binds `@xterm/xterm` to the minimal `Terminal` contract, attaches `FitAddon` + `WebLinksAddon`. The only library file that imports xterm.
- `create-workbench.ts` — the convenience factory; composes all of the above with default choices, including a minimal in-place terminal input loop that feeds lines into the human bash.
- `index.ts` — public re-exports. `createWorkbench` is canonical; piecewise exports flagged unstable in the header.

Host-only (`src/lib-host/`):
- `workspace-handle-store.ts` — IndexedDB persistence + picker-or-resume flow via `idb-keyval` + `openBrowserFilesApi` from `@statewalker/webrun-files-browser`.

App UI (`src/ui/`):
- `landing.tsx` — pre-workbench screens (initial, cancelled, key-required, permission-denied, error, unsupported-browser).
- `ask-gemini-key.tsx` — React modal mounted imperatively, suitable as `onSecretRequest`.
- `secrets-banner.tsx` — dismissable `.gitignore` reminder shown above the terminal.

### Constraints

- **Browser support**: Chromium-family only (Chrome / Edge / Opera / Arc). The app uses `window.showDirectoryPicker()` for workspace selection; Firefox and Safari render an "unsupported browser" page. No OPFS fallback in v1 — adding it doubles the UX surface without solving the "talk to a model about my repo" story.
- **Workspace handle lifetime**: the picked `FileSystemDirectoryHandle` is persisted in IndexedDB so reload re-opens the same directory. The browser still re-prompts for permission on every reload; the user has to click "Allow" each session. We cache nothing more than the handle itself.
- **Secrets live inside the workspace**. `/.settings/secrets.json` is written into the picked folder (hidden from the model via `FilteredFilesApi`, never via `userFiles`). The app shows a banner urging the user to add `/.settings/` to `.gitignore`. This is a deliberate choice over IndexedDB-only secrets; the leak surface is real.
- **Single-provider v1**: `google/gemini-2.5-flash` is the only configured provider. Multi-provider support (Anthropic / OpenAI) is deferred — the secret store can carry multiple keys, but only `GEMINI_API_KEY` is read at boot.
- **Single-session per workspace**: `session id = workbench/<workspace-key>/main`. No multi-session UI. `session reset` (human-terminal command) wipes the persisted session and starts fresh.
- **`just-bash` browser-bundle gotcha**: just-bash's `browser` export condition is a stripped bundle that doesn't re-export `decodeBytesToUtf8`, which `@just-bash/executor` imports. The Vite config sets `resolve.conditions: ["module", "import", "default"]` to skip the `browser` condition globally and pick the universal bundle. Bundle-size cost ~30KB gz. Revisit when upstream fixes the export.
- **`@executor-js/sdk` optional peer deps**: `@just-bash/executor` declares the SDK as an optional peer for the discovery path. We use inline tools only, so the SDK code is a dead branch. Vite's `build.rollupOptions.external: [/^@executor-js\/sdk/]` keeps the build from trying to resolve it.
- **No node-tagged code in `src/lib/`**. The library is Vite-buildable for the browser target with no `node:*` imports.
- **API surface drift risk**: both `createWorkbench` and the piecewise factories are exported. `createWorkbench` is the canonical surface; piecewise exports exist for power users but are subject to incompatible change.

### Dependencies

- `@flue/runtime` (specifically `@flue/runtime/internal` + `@flue/runtime/app`) — the agent loop, harness, and provider configuration.
- `@earendil-works/pi-ai` — provider registry with a native `./google` subpath for Gemini. Verified during apply task 1.3.
- `@earendil-works/pi-agent-core` — transitive Flue dep, listed explicitly so peer-dep resolution is deterministic.
- `just-bash` — the shell. Resolved against the universal bundle (see Constraints) so both the model's bash tool and the human-facing terminal share the same `Bash` class.
- `@just-bash/executor` — wires Flue tools as bash commands + js-exec tools.
- `@statewalker/webrun-files` — the `FilesApi` abstraction the adapter wraps.
- `@statewalker/webrun-files-browser` — `BrowserFilesApi` over `FileSystemDirectoryHandle` + `openBrowserFilesApi` helper. App-facing only.
- `@statewalker/webrun-files-mem` — `MemFilesApi`. Used in tests.
- `@statewalker/webrun-files-composite` — `FilteredFilesApi`, the system/user view split.
- `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` — terminal emulator.
- `idb-keyval` — IndexedDB persistence for the `FileSystemDirectoryHandle`. Host-only.
- `react` / `react-dom` — app UI only; the library has no React dependency.

## License

MIT © statewalker
