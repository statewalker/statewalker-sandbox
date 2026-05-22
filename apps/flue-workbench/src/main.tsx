import type { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createWorkbench,
  mountXtermTerminal,
  type Workbench,
  WorkbenchSecretMissingError,
} from "./lib/index.js";
import { openOrResumeWorkspace } from "./lib-host/workspace-handle-store.js";
import { askGeminiKey } from "./ui/ask-gemini-key.js";
import { isSupportedBrowser, Landing, type LandingReason } from "./ui/landing.js";
import { SecretsBanner } from "./ui/secrets-banner.js";

type Stage =
  | { kind: "landing"; reason: LandingReason }
  | { kind: "booting" }
  // Workspace picked; terminal container is rendered at full size so xterm
  // has a sized DOM node to open into. The useEffect below mounts xterm +
  // runs createWorkbench, then transitions to "running" on success.
  | { kind: "wiring"; files: BrowserFilesApi; workspaceKey: string }
  | { kind: "running"; workspaceName: string };

function App() {
  const [stage, setStage] = useState<Stage>({ kind: "landing", reason: { kind: "initial" } });
  const termHostRef = useRef<HTMLDivElement | null>(null);
  const workbenchRef = useRef<Workbench | null>(null);
  const xtermRef = useRef<{ dispose: () => void } | null>(null);

  useEffect(() => {
    if (!isSupportedBrowser()) {
      setStage({ kind: "landing", reason: { kind: "unsupported-browser" } });
    }
  }, []);

  const pickWorkspace = async () => {
    setStage({ kind: "booting" });
    try {
      const { files, workspaceKey } = await openOrResumeWorkspace();
      // Flip to "wiring" so React lays out the terminal container at full
      // size *before* we call mountXtermTerminal — xterm reads dimensions
      // from the host element at open() time and won't refit automatically
      // when the host grows later.
      setStage({ kind: "wiring", files, workspaceKey });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setStage({ kind: "landing", reason: { kind: "cancelled" } });
        return;
      }
      setStage({
        kind: "landing",
        reason: { kind: "error", message: err instanceof Error ? err.message : String(err) },
      });
    }
  };

  // Mount xterm + createWorkbench in an effect so the container is laid out
  // before xterm.open() reads its dimensions.
  useEffect(() => {
    if (stage.kind !== "wiring") return;
    const host = termHostRef.current;
    if (!host) return;

    let cancelled = false;
    const mounted = mountXtermTerminal({
      container: host,
      banner: (t) => t.writeln('\x1b[36mflue-workbench> ready. try: agent "hello"\x1b[0m'),
    });
    xtermRef.current = mounted;

    (async () => {
      try {
        const workbench = await createWorkbench({
          rootFiles: stage.files,
          workspaceKey: stage.workspaceKey,
          terminal: mounted.term,
          onSecretRequest: askGeminiKey,
        });
        if (cancelled) {
          await workbench.dispose();
          mounted.dispose();
          xtermRef.current = null;
          return;
        }
        workbenchRef.current = workbench;
        setStage({ kind: "running", workspaceName: stage.workspaceKey });
      } catch (err) {
        mounted.dispose();
        xtermRef.current = null;
        if (cancelled) return;
        if (err instanceof WorkbenchSecretMissingError) {
          setStage({ kind: "landing", reason: { kind: "key-required" } });
        } else {
          setStage({
            kind: "landing",
            reason: { kind: "error", message: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-run only when the workspace identity changes.
  }, [
    stage.kind,
    stage.kind === "wiring" ? stage.files : null,
    stage.kind === "wiring" ? stage.workspaceKey : null,
  ]);

  // Cleanup on unmount.
  useEffect(
    () => () => {
      workbenchRef.current?.dispose();
      xtermRef.current?.dispose();
    },
    [],
  );

  // Terminal container is rendered at full size whenever it should be visible
  // (wiring + running) so xterm has a sized DOM node before we call open().
  const terminalVisible = stage.kind === "wiring" || stage.kind === "running";

  return (
    <>
      {stage.kind === "running" && <SecretsBanner workspaceName={stage.workspaceName} />}
      {terminalVisible && (
        <div
          ref={termHostRef}
          style={{
            width: "100%",
            height: stage.kind === "running" ? "calc(100vh - 2.5rem)" : "100vh",
            background: "#1e1e1e",
          }}
        />
      )}
      {stage.kind === "landing" && (
        <Landing reason={stage.reason} onPickWorkspace={pickWorkspace} />
      )}
      {stage.kind === "booting" && (
        <main style={{ fontFamily: "system-ui, sans-serif", padding: "4rem", textAlign: "center" }}>
          Loading workspace…
        </main>
      )}
    </>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
