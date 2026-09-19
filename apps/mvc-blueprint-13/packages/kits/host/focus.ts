/**
 * The host rule "dialog focus returns to the last focused element" (P0 fail 8, U1), per mounted
 * host — no module-level state. The browser blurs an opener that gets disabled while its dialog is
 * open (Clear completed shows `running`), so `activeElement` at open time can be <body>: the last
 * element focused outside a dialog is remembered instead.
 */
export interface FocusReturn {
  /** Call when a dialog appears; returns what to call when it is withdrawn. */
  opened(): () => void;
  dispose(): void;
}

export function newFocusReturn(doc: Document): FocusReturn {
  let last: Element | null = null;
  const onFocus = (event: FocusEvent) => {
    const target = event.target as Element;
    if (!target.closest?.('[role="dialog"]')) last = target;
  };
  doc.addEventListener("focusin", onFocus);
  return {
    opened() {
      const opener = doc.activeElement !== doc.body ? doc.activeElement : last;
      return () => {
        // After the withdrawal has rendered: the opener may have been disabled while the dialog ran.
        setTimeout(() => {
          if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
        }, 0);
      };
    },
    dispose: () => doc.removeEventListener("focusin", onFocus),
  };
}
