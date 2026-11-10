/**
 * git's ref-name rules, as refs.c check_refname_component / check_refname_format apply them
 * (`git help check-ref-format`). A name is a sequence of `/`-separated components; a component
 * may not be empty, start with `.`, contain `..` or `@{`, end with `.lock`, or contain control
 * characters, DEL, space, `~ ^ : ? [ \ *`. The name may not be `@` or end with `.`, and needs two
 * components unless one level is allowed. Bytes >= 0x80 (UTF-8) are allowed.
 */
const BAD = new Set([" ", "~", "^", ":", "?", "[", "\\", "*", "\u007f"]);

function badComponent(c: string): boolean {
  if (c.length === 0 || c.startsWith(".") || c.endsWith(".lock")) return true;
  let prev = "";
  for (const ch of c) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x20 || BAD.has(ch)) return true;
    if (ch === "." && prev === ".") return true;
    if (ch === "{" && prev === "@") return true;
    prev = ch;
  }
  return false;
}

export function checkRefFormat(name: string, opts: { allowOneLevel?: boolean } = {}): boolean {
  if (name === "@" || name.endsWith(".")) return false;
  const parts = name.split("/");
  if (parts.some(badComponent)) return false;
  return opts.allowOneLevel === true || parts.length >= 2;
}

/** Byte order of the UTF-8 encodings (= code-point order), the order git sorts refs in. */
export function compareRefNames(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const d = (x.value.codePointAt(0) as number) - (y.value.codePointAt(0) as number);
    if (d !== 0) return d;
  }
}
