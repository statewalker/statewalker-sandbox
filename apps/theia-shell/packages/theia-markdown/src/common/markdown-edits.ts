/** Wrap `selection` in `marker` (e.g. `**`), or unwrap it if already wrapped. */
export function toggleWrap(selection: string, marker: string): string {
  if (
    selection.length >= marker.length * 2 &&
    selection.startsWith(marker) &&
    selection.endsWith(marker)
  ) {
    return selection.slice(marker.length, selection.length - marker.length);
  }
  return `${marker}${selection}${marker}`;
}

/** Cycle a line through heading levels: text → `#` → … → `######` → text. */
export function toggleHeading(line: string): string {
  const match = /^(#{1,6})[ \t]+(.*)$/.exec(line);
  if (!match) return `# ${line}`;
  const level = match[1].length;
  return level >= 6 ? match[2] : `${"#".repeat(level + 1)} ${match[2]}`;
}

/** The first of `untitled.md`, `untitled-2.md`, … not among `existing`. */
export function nextUntitledName(existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has("untitled.md")) return "untitled.md";
  for (let n = 2; ; n++) {
    const name = `untitled-${n}.md`;
    if (!taken.has(name)) return name;
  }
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}
