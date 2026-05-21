import { useState } from "react";

/**
 * Dismissable banner shown above the terminal while a secret file lives
 * inside the picked workspace. Reminds the user to add `/.settings/` to
 * `.gitignore` so they don't commit their key.
 */
export function SecretsBanner({ workspaceName }: { workspaceName: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div
      style={{
        background: "#fef3c7",
        color: "#78350f",
        padding: "0.5rem 1rem",
        borderBottom: "1px solid #fcd34d",
        fontFamily: "system-ui, sans-serif",
        fontSize: "0.9rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <span>
        <strong>Heads up:</strong> your Gemini key is stored in{" "}
        <code>{workspaceName}/.settings/secrets.json</code>. Add <code>/.settings/</code> to your{" "}
        <code>.gitignore</code>.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        style={{
          background: "transparent",
          border: 0,
          color: "#78350f",
          cursor: "pointer",
          fontSize: "1.1rem",
          padding: "0 0.25rem",
        }}
        aria-label="Dismiss banner"
      >
        ×
      </button>
    </div>
  );
}
