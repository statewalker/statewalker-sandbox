/**
 * Minimal terminal contract the library depends on. Borrowed from
 * just-bash's example `LiteTerminal` shape — also satisfied by
 * `@xterm/xterm`'s `Terminal` directly, so adoption is a one-line
 * adapter.
 *
 * Library code never imports xterm; the host wires it in via
 * `mountXtermTerminal` (or any other emulator implementing this
 * interface).
 */
export interface Terminal {
  write(data: string): void;
  writeln(data: string): void;
  clear(): void;
  onData(cb: (data: string) => void): { dispose(): void };
}
