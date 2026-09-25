/** "Local Computer" → "local-computer"; nothing usable → "mount". */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "mount";
}

/** The slug of `name`, or the first free `<slug>-2`, `<slug>-3`… */
export function suggestKey(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(name);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
  }
}

/** Why `key` cannot name a mount, or undefined if it can. */
export function validateKey(key: string, taken: Iterable<string>): string | undefined {
  if (!key) return "A key is required.";
  if (key === "." || key === "..") return `"${key}" cannot be a key.`;
  if (key.includes("/")) return "A key cannot contain '/'.";
  if (new Set(taken).has(key)) return `The key "${key}" is already used.`;
  return undefined;
}
