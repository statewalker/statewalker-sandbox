import type { ReactNode } from "react";

export interface LandingProps {
  reason: LandingReason;
  onPickWorkspace?: () => void;
}

export type LandingReason =
  | { kind: "initial" }
  | { kind: "unsupported-browser" }
  | { kind: "cancelled" }
  | { kind: "key-required" }
  | { kind: "permission-denied" }
  | { kind: "error"; message: string };

/**
 * Pre-workbench landing. Branches on the reason the user is here:
 * - initial: the welcome / pick-workspace screen
 * - unsupported-browser: Firefox / Safari (no showDirectoryPicker)
 * - cancelled: user dismissed the picker
 * - key-required: user dismissed the Gemini-key modal
 * - permission-denied: cached handle but permission not re-granted
 * - error: catch-all
 */
export function Landing(props: LandingProps): ReactNode {
  switch (props.reason.kind) {
    case "unsupported-browser":
      return (
        <Frame title="Browser not supported">
          <p>
            Flue Workbench requires a Chromium-based browser (Chrome, Edge, Arc, Opera) — the File
            System Access API is not available in Firefox or Safari.
          </p>
        </Frame>
      );
    case "initial":
      return (
        <Frame title="Flue Workbench">
          <p>
            Pick a local directory and chat with a Gemini-powered agent that can read, edit, and run
            shell commands inside it. Settings live in <code>/.settings/</code> inside the picked
            folder — remember to add that to <code>.gitignore</code>.
          </p>
          <button type="button" onClick={props.onPickWorkspace}>
            Pick workspace
          </button>
        </Frame>
      );
    case "cancelled":
      return (
        <Frame title="Workspace not picked">
          <p>The picker was dismissed. Click below to try again.</p>
          <button type="button" onClick={props.onPickWorkspace}>
            Pick workspace
          </button>
        </Frame>
      );
    case "key-required":
      return (
        <Frame title="Gemini API key required">
          <p>
            The workbench can't start without a Gemini API key. Click below to pick a workspace and
            try again — the modal will let you paste a key.
          </p>
          <button type="button" onClick={props.onPickWorkspace}>
            Try again
          </button>
        </Frame>
      );
    case "permission-denied":
      return (
        <Frame title="Permission denied">
          <p>
            Your browser blocked access to the previously picked directory. Pick it again to grant
            permission.
          </p>
          <button type="button" onClick={props.onPickWorkspace}>
            Re-pick workspace
          </button>
        </Frame>
      );
    case "error":
      return (
        <Frame title="Something went wrong">
          <pre style={{ whiteSpace: "pre-wrap", color: "#b91c1c" }}>{props.reason.message}</pre>
          <button type="button" onClick={props.onPickWorkspace}>
            Try again
          </button>
        </Frame>
      );
  }
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: "40rem",
        margin: "4rem auto",
        padding: "2rem",
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ marginTop: 0 }}>{title}</h1>
      {children}
    </main>
  );
}

export function isSupportedBrowser(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}
