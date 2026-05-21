import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * Imperative wrapper around the React modal: mounts a fresh root,
 * resolves with the user-supplied key, rejects if dismissed. Suitable
 * for use as `onSecretRequest` in `createWorkbench`.
 */
export function askGeminiKey(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const cleanup = () => {
      root.unmount();
      container.remove();
    };

    root.render(
      <GeminiKeyModal
        onSubmit={(key) => {
          cleanup();
          resolve(key);
        }}
        onDismiss={() => {
          cleanup();
          reject(new Error("user dismissed the secrets modal"));
        }}
      />,
    );
  });
}

function GeminiKeyModal(props: { onSubmit: (key: string) => void; onDismiss: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Programmatic focus instead of `autoFocus` (lint/a11y/noAutofocus).
  // For a modal popped explicitly to capture input, focusing on mount is
  // expected; doing it via effect keeps the linter and screen readers happy.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Please paste a key.");
      return;
    }
    if (trimmed.length < 20) {
      setError("That doesn't look like a Gemini API key — too short.");
      return;
    }
    props.onSubmit(trimmed);
  };

  return (
    <div style={overlay}>
      <form onSubmit={submit} style={dialog} aria-label="Gemini API key">
        <h2 style={{ marginTop: 0 }}>Gemini API key required</h2>
        <p style={{ marginTop: 0, color: "#555" }}>
          Get a key at <a href="https://aistudio.google.com/app/apikey">aistudio.google.com</a>. The
          key is stored in <code>/.settings/secrets.json</code> inside the picked workspace — add
          that path to <code>.gitignore</code>.
        </p>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder="AIza..."
          style={input}
          aria-label="Gemini API key"
        />
        {error && <p style={errorMsg}>{error}</p>}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button type="button" onClick={props.onDismiss} style={btnSecondary}>
            Cancel
          </button>
          <button type="submit" style={btnPrimary}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
};
const dialog: React.CSSProperties = {
  background: "white",
  borderRadius: "0.5rem",
  padding: "1.5rem 2rem",
  maxWidth: "30rem",
  width: "90%",
  fontFamily: "system-ui, sans-serif",
};
const input: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  fontSize: "1rem",
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
  marginBottom: "0.5rem",
  boxSizing: "border-box",
};
const errorMsg: React.CSSProperties = { color: "#b91c1c", margin: "0 0 0.5rem" };
const btnPrimary: React.CSSProperties = {
  background: "#0a64dc",
  color: "white",
  border: 0,
  borderRadius: "0.25rem",
  padding: "0.5rem 1rem",
  cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  background: "transparent",
  color: "#555",
  border: "1px solid #ccc",
  borderRadius: "0.25rem",
  padding: "0.5rem 1rem",
  cursor: "pointer",
};
