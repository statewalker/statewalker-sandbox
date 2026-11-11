/**
 * git's config format (Documentation/config.txt "Syntax"; parsing as git's config.c
 * `parse_value`): sections `[name]` and `[name "sub"]` (and the deprecated `[name.sub]`),
 * `key = value` (or a bare `key`: true), `#`/`;` comments, quoted values with `\"`, `\\`, `\n`,
 * `\t`, `\b` escapes, a `\` at the end of a line (outside a comment) continuing the value, each
 * unquoted whitespace character read as one space and trailing ones dropped, CRLF line ends.
 * Section and key names are case-insensitive, subsections not.
 *
 * An edit replaces one line (or adds one after the section's last key): everything else —
 * comments, layout, order — stays byte for byte, as `git config` does. Like git, `set` refuses a
 * name git cannot read back and a key that has several values.
 */
interface Entry {
  key: string; // section[.sub].name, section and name lower-cased
  section: string;
  value: string;
  line: number; // first line of the entry
  lines: number; // lines it spans (continuations)
  /** the entry follows its section header on the header's line: the header's text */
  header?: string;
}

const SECTION = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\\n]|\\.)*)")?\s*\]/;
const SECTION_NAME = /^[A-Za-z0-9-]+$/;
const KEY_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const stripCr = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);
const isSpace = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\v" || c === "\f";

/** git's parse_value from `text` (the rest of line `i` after `=`), following continuations. */
function parseValue(lines: string[], i: number, text: string): { value: string; span: number } {
  let out = "";
  let quoted = false;
  let comment = false;
  let spaces = 0;
  let span = 1;
  let s = text;
  let j = 0;
  for (;;) {
    if (j >= s.length) break; // end of the line ends the value
    const c = s[j++] as string;
    if (comment) continue;
    if (!quoted && isSpace(c)) {
      if (out.length) spaces++;
      continue;
    }
    if (!quoted && (c === ";" || c === "#")) {
      comment = true;
      continue;
    }
    for (; spaces; spaces--) out += " ";
    if (c === "\\") {
      if (j >= s.length) {
        // a continuation: the value goes on with the next line
        if (i + span >= lines.length) break;
        s = stripCr(lines[i + span] as string);
        span++;
        j = 0;
        continue;
      }
      const n = s[j++] as string;
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "b" ? "\b" : n;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    out += c;
  }
  return { value: out, span };
}

/** git's write_pair: quoted when it starts or ends with a space or holds a comment character */
function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\x08/g, "\\b");
  return /^\s|\s$|[#;]/.test(value) ? `"${escaped}"` : escaped;
}

/** git_config_parse_key: section[.subsection].name */
function splitKey(key: string): { section: string; sub?: string; name: string } {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  const bad = () => new Error(`invalid key: ${JSON.stringify(key)}`);
  if (first < 0) throw bad();
  const section = key.slice(0, first);
  const sub = first === last ? undefined : key.slice(first + 1, last);
  const name = key.slice(last + 1);
  if (!SECTION_NAME.test(section) || !KEY_NAME.test(name)) throw bad();
  if (sub !== undefined && /[\n\0]/.test(sub)) throw bad();
  return { section: section.toLowerCase(), sub, name: name.toLowerCase() };
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
      let line = stripCr(this.lines[i] as string);
      let header: string | undefined;
      const h = SECTION.exec(line);
      if (h) {
        const name = (h[1] as string).toLowerCase();
        const sub = h[2] !== undefined ? h[2].replace(/\\(.)/g, "$1") : undefined;
        section = sub !== undefined ? `${name}.${sub}` : name;
        this.headers.push({ id: section, line: i });
        header = h[0];
        line = line.slice(h[0].length);
      }
      if (!section || !line.trim() || /^\s*[#;]/.test(line)) continue;
      const m = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(=?)/.exec(line);
      if (!m) continue;
      const { value, span } = m[2]
        ? parseValue(this.lines, i, line.slice(m[0].length))
        : { value: "true", span: 1 };
      this.entries.push({
        key: `${section}.${(m[1] as string).toLowerCase()}`,
        section,
        value,
        line: i,
        lines: span,
        header,
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
  /** Sets `key` (one value: replaced; none: added to its section, or a new section). */
  set(key: string, value: string) {
    const k = splitKey(key);
    if (/[\r\0]/.test(value)) throw new Error(`invalid value for ${key}: CR and NUL are not kept`);
    const id = k.sub === undefined ? k.section : `${k.section}.${k.sub}`;
    const line = `\t${k.name} = ${quote(value)}`;
    const existing = this.entries.filter((e) => e.key === `${id}.${k.name}`);
    if (existing.length > 1)
      throw new Error(`${key}: cannot overwrite multiple values with a single value`);
    const e = existing[0];
    if (e) {
      // a key on its header's line: the header stays, the key goes on its own line
      if (e.header !== undefined) this.lines.splice(e.line, e.lines, e.header, line);
      else this.lines.splice(e.line, e.lines, line);
    } else {
      const header = this.headers.filter((h) => h.id === id).at(-1);
      if (header) {
        const last = this.entries.filter((x) => x.section === id && x.line >= header.line).at(-1);
        this.lines.splice(last ? last.line + last.lines : header.line + 1, 0, line);
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
