// Datalog vocabulary: which file method is which operation, the host-side policy of each
// session mode, the authority block minted per session, and ready-made attenuation blocks.
//
// Facts provided by the authorizer on every call (always bound as parameters):
//   operation({op})    "read" | "list" | "write"
//   resource({path})   normalised absolute path + "/"
//   (the session is read from the token's authority block; the owner then loads THAT session's
//    mode and revocations, which is what binds a token to its session and workspace)
//
// Modes only ever restrict what the token's right($r) facts allow; attenuation blocks
// (checks) narrow further. No matching `allow` → deny.

export type Op = "read" | "list" | "write";

export const OPS: Record<string, Op> = {
  readFile: "read",
  readFileBuffer: "read",
  exists: "list",
  stat: "list",
  lstat: "list",
  readdir: "list",
  realpath: "list",
  writeFile: "write",
  appendFile: "write",
  mkdir: "write",
  rm: "write",
  chmod: "write",
  utimes: "write",
};

// Listing an ANCESTOR of a right is allowed so `ls /` can show the allowed branches;
// readdir() then filters the children one by one.
const ANCESTOR_LIST = `allow if operation("list"), resource($p), right($r), $r.starts_with($p);`;

export const MODES: Record<string, string> = {
  // Everything inside the user's rights.
  yolo: `
allow if resource($p), right($r), $p.starts_with($r);
${ANCESTOR_LIST}`,
  // Work freely, but only inside /proj/ (and read everything the rights allow).
  prototyping: `
allow if operation($o), ["read","list"].contains($o), resource($p), right($r), $p.starts_with($r);
allow if operation("write"), resource($p), $p.starts_with("/proj/"), right($r), $p.starts_with($r);
${ANCESTOR_LIST}`,
  // Planning: read everything in rights, write only plan artefacts under /plans/.
  plan: `
allow if operation($o), ["read","list"].contains($o), resource($p), right($r), $p.starts_with($r);
allow if operation("write"), resource($p), $p.starts_with("/plans/"), right($r), $p.starts_with($r);
${ANCESTOR_LIST}`,
  // Constrained: read-only.
  readonly: `
allow if operation($o), ["read","list"].contains($o), resource($p), right($r), $p.starts_with($r);
${ANCESTOR_LIST}`,
};

export const isMode = (m: unknown): m is string => typeof m === "string" && Object.hasOwn(MODES, m);

const esc = (s: string) => JSON.stringify(String(s));
const dirRight = (r: string) => (r === "/" ? "/" : r.replace(/\/?$/, "/"));

/** Authority block for one session. Rights end with "/" (see asResource). */
export function authorityBlock(a: { user: string; session: string; rights: string[] }): string {
  return [
    `user(${esc(a.user)});`,
    `session(${esc(a.session)});`,
    ...a.rights.map((r) => `right(${esc(dirRight(r))});`),
  ].join("\n");
}

// Ready-made attenuation blocks. A scope also lets the holder LIST the ancestors of its
// subtree (so `ls /` shows the one branch it has, as the mode policies do for rights).
const scopeBody = (prefix: string) => {
  const r = esc(dirRight(prefix));
  return `resource($p), $p.starts_with(${r}) or operation("list"), resource($p), ${r}.starts_with($p)`;
};
export const scopeTo = (prefix: string): string => `check if ${scopeBody(prefix)};`;
export const READ_ONLY = `check if operation($o), ["read","list"].contains($o);`;

/** Attenuation from a JSON description: { scope?: string|string[], readOnly?: boolean }. */
export function attenuationBlock(spec: {
  scope?: string | string[];
  readOnly?: boolean;
  datalog?: string;
}): string {
  const lines: string[] = [];
  const scopes =
    spec.scope === undefined ? [] : Array.isArray(spec.scope) ? spec.scope : [spec.scope];
  if (scopes.length === 1) lines.push(scopeTo(scopes[0] as string));
  else if (scopes.length > 1) {
    // One check, several alternatives: `check if A or B` is written as several bodies.
    lines.push(`check if ${scopes.map(scopeBody).join(" or ")};`);
  }
  if (spec.readOnly) lines.push(READ_ONLY);
  if (spec.datalog) lines.push(spec.datalog);
  if (lines.length === 0) throw new Error("EINVAL: empty attenuation");
  return lines.join("\n");
}
