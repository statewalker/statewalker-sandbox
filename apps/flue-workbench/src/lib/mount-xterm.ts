import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { Terminal } from "./terminal-contract.js";

export interface MountXtermOptions {
  container: HTMLElement;
  theme?: NonNullable<ConstructorParameters<typeof Xterm>[0]>["theme"];
  fontFamily?: string;
  fontSize?: number;
  /** Optional banner written to the terminal after open(). */
  banner?: (term: Terminal) => void;
}

export interface MountedXterm {
  /** Adapter satisfying our minimal Terminal contract. */
  term: Terminal;
  /** Underlying xterm.js instance, if you need addons or APIs we don't expose. */
  xterm: Xterm;
  dispose(): void;
}

/**
 * Mount an xterm.js instance into the given container, attach `FitAddon`
 * + `WebLinksAddon`, install a window resize listener, and return the
 * minimal `Terminal` contract for the workbench library to drive.
 *
 * Library code only uses the four-method `Terminal` interface; xterm
 * itself is referenced only inside this file so swapping in a different
 * emulator (e.g. just-bash's LiteTerminal) is a single-file change.
 */
export function mountXtermTerminal(opts: MountXtermOptions): MountedXterm {
  const xterm = new Xterm({
    cursorBlink: true,
    convertEol: true,
    fontFamily: opts.fontFamily ?? "ui-monospace, SFMono-Regular, monospace",
    fontSize: opts.fontSize ?? 13,
    theme: opts.theme,
  });

  const fit = new FitAddon();
  xterm.loadAddon(fit);
  xterm.loadAddon(new WebLinksAddon());

  xterm.open(opts.container);
  fit.fit();

  // Refit on both window resize AND container size changes (the latter covers
  // the case where the host element is re-laid-out by surrounding React state
  // — e.g. a banner appearing above it). Without the ResizeObserver, xterm
  // would render at the size it had at open() time and never grow/shrink.
  const refit = () => {
    try {
      fit.fit();
    } catch {
      // fit() can throw if the container is detached or zero-sized; ignore.
    }
  };
  window.addEventListener("resize", refit);
  const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(refit) : null;
  resizeObserver?.observe(opts.container);

  const term: Terminal = {
    write: (data) => xterm.write(data),
    writeln: (data) => xterm.writeln(data),
    clear: () => xterm.clear(),
    onData: (cb) => {
      const sub = xterm.onData(cb);
      return { dispose: () => sub.dispose() };
    },
  };

  opts.banner?.(term);

  return {
    term,
    xterm,
    dispose: () => {
      window.removeEventListener("resize", refit);
      resizeObserver?.disconnect();
      xterm.dispose();
    },
  };
}
