/** A heading in a Markdown document; `line` is 0-based. */
export interface OutlineItem {
  level: number;
  text: string;
  line: number;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The headings of a Markdown document, in order: ATX (`# x`) and setext
 * (`x` underlined with `===`/`---`), skipping fenced code. Inline markup is
 * stripped from the labels.
 */
export function parseOutline(text: string): OutlineItem[] {
  const lines = text.split(/\r?\n/);
  const items: OutlineItem[] = [];
  let fence: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      items.push({ level: atx[1].length, text: plain(atx[2] ?? ""), line: i });
      continue;
    }
    const next = lines[i + 1];
    const setext = next === undefined ? null : SETEXT.exec(next);
    if (setext && isParagraphLine(line)) {
      items.push({ level: setext[1][0] === "=" ? 1 : 2, text: plain(line.trim()), line: i });
      i++;
    }
  }
  return items;
}

function isParagraphLine(line: string): boolean {
  return line.trim() !== "" && !/^ {4}/.test(line) && !/^ {0,3}([-*+>]|\d+[.)])[ \t]/.test(line);
}

function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, "$2")
    .trim();
}
