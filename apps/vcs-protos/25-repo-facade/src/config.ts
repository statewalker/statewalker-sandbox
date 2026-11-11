/**
 * git's config format (Documentation/config.txt "Syntax"): sections `[name]` and `[name "sub"]`,
 * `key = value` (or a bare `key`: true), `#`/`;` comments, quoted values with `\"`, `\\`, `\n`,
 * `\t`, `\b` escapes, a trailing `\` continuing the value. Names are case-insensitive, subsections
 * not. An edit replaces one line (or adds one): everything else — comments, layout, order — stays
 * byte for byte, as `git config` does.
 */
interface Entry {
  key: string; // section[.sub].name, section and name lower-cased
  value: string;
  line: number; // first line of the entry
  lines: number; // lines it spans (continuations)
}

const SECTION = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/;

function unquote(raw: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c === "\\") {
      const n = raw[++i];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "b" ? "\b" : (n ?? "");
    } else if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "#" || c === ";")) break;
    else out += c;
  }
  return quoted ? out : out.replace(/\s+$/, "");
}

function quote(value: string): string {
  const needs = /^\s|\s$|[#;"\\\n\t]/.test(value);
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return needs ? `"${escaped}"` : escaped;
}

function splitKey(key: string): { section: string; sub?: string; name: string } {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0 || (first === last && first === -1)) throw new Error(`bad config key ${key}`);
  return {
    section: key.slice(0, first).toLowerCase(),
    sub: first === last ? undefined : key.slice(first + 1, last),
    name: key.slice(last + 1).toLowerCase(),
  };
}
const canonical = (key: string) => {
  const k = splitKey(key);
  return k.sub === undefined ? `${k.section}.${k.name}` : `${k.section}.${k.sub}.${k.name}`;
};

export class GitConfig {
  private lines: string[];
  private entries: Entry[] = [];
  /** section headers: canonical "section" or "section.sub" → the line index of the header */
  private headers: { id: string; line: number }[] = [];
  constructor(text: string) {
    this.lines = text.length ? text.replace(/\n$/, "").split("\n") : [];
    this.parse();
  }
  private parse() {
    this.entries = [];
    this.headers = [];
    let section: string | undefined;
    for (let i = 0; i < this.lines.length; i++) {
      let line = this.lines[i] as string;
      const h = SECTION.exec(line);
      if (h) {
        const name = (h[1] as string).toLowerCase();
        // the deprecated [section.sub] form has its subsection lower-cased
        const sub = h[2] !== undefined ? h[2].replace(/\\(.)/g, "$1") : undefined;
        section = sub !== undefined ? `${name}.${sub}` : name;
        this.headers.push({ id: section, line: i });
        line = line.slice(h[0].length);
        if (!line.trim() || /^\s*[#;]/.test(line)) continue;
      }
      if (!section || !line.trim() || /^\s*[#;]/.test(line)) continue;
      const m = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/.exec(line);
      if (!m) continue;
      let raw = m[2] ?? "";
      let span = 1;
      while (raw.endsWith("\\") && i + span < this.lines.length) {
        raw = raw.slice(0, -1) + (this.lines[i + span] as string);
        span++;
      }
      this.entries.push({
        key: `${section}.${(m[1] as string).toLowerCase()}`,
        value: m[2] === undefined ? "true" : unquote(raw.trim()),
        line: i,
        lines: span,
      });
      i += span - 1;
    }
  }
  get(key: string): string | undefined {
    return this.getAll(key).at(-1);
  }
  getAll(key: string): string[] {
    const k = canonical(key);
    return this.entries.filter((e) => e.key === k).map((e) => e.value);
  }
  /** Sets the last occurrence of `key` (or adds it to its section, or a new section). */
  set(key: string, value: string) {
    const k = splitKey(key);
    const id = k.sub === undefined ? k.section : `${k.section}.${k.sub}`;
    const line = `\t${k.name} = ${quote(value)}`;
    const existing = this.entries.filter((e) => e.key === `${id}.${k.name}`).at(-1);
    if (existing) this.lines.splice(existing.line, existing.lines, line);
    else {
      const header = this.headers.filter((h) => h.id === id).at(-1);
      if (header) {
        // after the section's last line (up to the next header)
        const next = this.headers.find((h) => h.line > header.line);
        let at = next ? next.line : this.lines.length;
        while (at > header.line + 1 && !(this.lines[at - 1] as string).trim()) at--;
        this.lines.splice(at, 0, line);
      } else {
        const sub =
          k.sub === undefined ? "" : ` "${k.sub.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        this.lines.push(`[${k.section}${sub}]`, line);
      }
    }
    this.parse();
  }
  text(): string {
    return this.lines.length ? `${this.lines.join("\n")}\n` : "";
  }
}
