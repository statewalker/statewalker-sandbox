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

function App() {
  const [stage, setStage] = useState<
    | { kind: "landing"; reason: LandingReason }
    | { kind: "booting" }
    | { kind: "running"; workspaceName: string }
  >({ kind: "landing", reason: { kind: "initial" } });
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
    let files: Awaited<ReturnType<typeof openOrResumeWorkspace>>["files"];
    let workspaceKey: string;
    try {
      const result = await openOrResumeWorkspace();
      files = result.files;
      workspaceKey = result.workspaceKey;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setStage({ kind: "landing", reason: { kind: "cancelled" } });
        return;
      }
      setStage({
        kind: "landing",
        reason: { kind: "error", message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }

    // Mount xterm now so createWorkbench has a terminal to attach to.
    const host = termHostRef.current;
    if (!host) throw new Error("terminal host element not present");
    const mounted = mountXtermTerminal({
      container: host,
      banner: (t) => t.writeln('\x1b[36mflue-workbench> ready. try: agent "hello"\x1b[0m'),
    });
    xtermRef.current = mounted;

    try {
      const workbench = await createWorkbench({
        rootFiles: files,
        workspaceKey,
        terminal: mounted.term,
        onSecretRequest: askGeminiKey,
      });
      workbenchRef.current = workbench;
      setStage({ kind: "running", workspaceName: workspaceKey });
    } catch (err) {
      mounted.dispose();
      xtermRef.current = null;
      if (err instanceof WorkbenchSecretMissingError) {
        setStage({ kind: "landing", reason: { kind: "key-required" } });
      } else {
        setStage({
          kind: "landing",
          reason: { kind: "error", message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  };

  useEffect(
    () => () => {
      workbenchRef.current?.dispose();
      xtermRef.current?.dispose();
    },
    [],
  );

  return (
    <>
      {stage.kind === "running" && <SecretsBanner workspaceName={stage.workspaceName} />}
      <div
        ref={termHostRef}
        style={{
          width: "100%",
          height: stage.kind === "running" ? "calc(100vh - 2.5rem)" : 0,
          background: "#1e1e1e",
        }}
      />
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
