import "../../src/browser/style/boot-gate.css";

/**
 * Shown before the workbench when the main storage is a local folder whose
 * access must be re-granted by a click (a browser rule). Plain DOM: Theia's
 * UI cannot start before the settings it would read from that folder.
 */
export function bootGate(
  name: string,
  requestAccess: () => Promise<boolean>,
  accessible: () => Promise<boolean>,
): Promise<"opened" | "fallback"> {
  return new Promise((resolve) => {
    const gate = document.createElement("div");
    gate.className = "boot-gate";
    const text = document.createElement("p");
    text.textContent = `Theia Shell keeps its files and settings in the folder “${name}”. Open it to continue.`;
    const open = document.createElement("button");
    open.className = "boot-gate-open";
    open.textContent = `Open “${name}”`;
    const fallback = document.createElement("button");
    fallback.className = "boot-gate-fallback";
    fallback.textContent = "Use Browser Storage this time";
    const done = (result: "opened" | "fallback") => {
      gate.remove();
      resolve(result);
    };
    open.onclick = async () => {
      if (!(await requestAccess())) {
        text.textContent = `Access to “${name}” was not granted.`;
        return;
      }
      if (!(await accessible())) {
        text.textContent = `The folder “${name}” is gone (moved or deleted).`;
        open.remove();
        return;
      }
      done("opened");
    };
    fallback.onclick = () => done("fallback");
    gate.append(text, open, fallback);
    document.body.appendChild(gate);
  });
}
