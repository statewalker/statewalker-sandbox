/**
 * X10a — the LFS object store on any FilesApi, in git-lfs's own layout under the repository root
 * (`lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>`): native git-lfs in a git-files repository reads what
 * we store and we read what it stored. Every write is streamed into `lfs/tmp/`, hashed (SHA-256)
 * and counted on the way, and renamed into place only when it matches what was expected — no
 * object becomes visible unverified. An interrupted download keeps its bytes as parts under
 * `lfs/incomplete/<oid>/` (written so that a failing source still leaves what arrived, on every
 * backend), resumed from their total and verified as a whole on completion.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { createSha256, toHex } from "../../03-sha256-blake3/src/hashes.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { encodePointer, MAX_POINTER_SIZE, type Pointer, parsePointer } from "./pointer.js";

export interface LfsStore {
  has(oid: string): Promise<boolean>;
  size(oid: string): Promise<number | undefined>;
  read(oid: string, opts?: { start?: number; signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  /** streamed, verified (SHA-256, and size when given), then visible */
  put(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    expect?: { oid: string; size?: number },
  ): Promise<Pointer>;
  /** bytes held for an interrupted download */
  incomplete: {
    size(oid: string): Promise<number>;
    append(oid: string, source: AsyncIterable<Uint8Array>): Promise<number>;
    /** verifies what is held and makes it visible */
    complete(expect: Pointer): Promise<void>;
    remove(oid: string): Promise<void>;
  };
}

export class LfsVerifyError extends Error {
  override name = "ObjectIdMismatchError";
}

const OID = /^[0-9a-f]{64}$/;
const randomId = () => toHex(crypto.getRandomValues(new Uint8Array(8)));

export function lfsStore(files: FilesApi, root: string): LfsStore {
  const at = (p: string) => (root ? `${root}/${p}` : p);
  const objectPath = (oid: string) => {
    if (!OID.test(oid)) throw new Error(`invalid lfs oid ${JSON.stringify(oid)}`);
    return at(`lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`);
  };
  const partsDir = (oid: string) => {
    if (!OID.test(oid)) throw new Error(`invalid lfs oid ${JSON.stringify(oid)}`);
    return at(`lfs/incomplete/${oid}`);
  };
  const parts = async (oid: string) => {
    const dir = partsDir(oid);
    if (!(await files.exists(dir))) return [];
    const out: { path: string; offset: number; size: number }[] = [];
    for await (const e of files.list(dir)) {
      if (e.kind !== "file") continue;
      const offset = Number(e.name);
      const st = await files.stats(`${dir}/${e.name}`);
      if (Number.isSafeInteger(offset) && st?.kind === "file")
        out.push({ path: `${dir}/${e.name}`, offset, size: st.size });
    }
    return out.sort((a, b) => a.offset - b.offset);
  };
  const size = async (oid: string) => {
    const st = await files.stats(objectPath(oid));
    return st?.kind === "file" ? (st.size ?? 0) : undefined;
  };
  const put: LfsStore["put"] = async (source, expect) => {
    const tmp = at(`lfs/tmp/${randomId()}`);
    const h = createSha256();
    let n = 0;
    async function* hashed() {
      for await (const c of source) {
        h.update(c);
        n += c.length;
        if (expect?.size !== undefined && n > expect.size)
          throw new LfsVerifyError(`lfs object ${expect.oid}: more than its ${expect.size} bytes`);
        yield c;
      }
    }
    try {
      await files.write(tmp, hashed());
      const oid = toHex(h.digest());
      if (expect && (oid !== expect.oid || (expect.size !== undefined && n !== expect.size)))
        throw new LfsVerifyError(
          `lfs object hashed to ${oid} (${n} bytes), expected ${expect.oid} (${expect.size} bytes)`,
        );
      if ((await size(oid)) === n) await files.remove(tmp);
      else await files.move(tmp, objectPath(oid));
      return { oid, size: n };
    } catch (e) {
      await files.remove(tmp).catch(() => false);
      throw e;
    }
  };
  const held = async (oid: string) => (await parts(oid)).reduce((s, p) => s + p.size, 0);
  return {
    has: async (oid) => OID.test(oid) && (await size(oid)) !== undefined,
    size,
    read: (oid, o = {}) => files.read(objectPath(oid), { start: o.start, signal: o.signal }),
    put,
    incomplete: {
      size: held,
      async append(oid, source) {
        const offset = await held(oid);
        let failure: unknown;
        let n = 0;
        // the source's failure ends the write normally: what arrived stays on every backend
        async function* upTo() {
          try {
            for await (const c of source) {
              n += c.length;
              yield c;
            }
          } catch (e) {
            failure = e;
          }
        }
        await files.write(`${partsDir(oid)}/${String(offset).padStart(16, "0")}`, upTo());
        if (failure) throw failure;
        return n;
      },
      async complete(expect) {
        const list = await parts(expect.oid);
        async function* all() {
          for (const p of list) yield* files.read(p.path);
        }
        try {
          await put(all(), expect);
        } finally {
          await files.remove(partsDir(expect.oid)).catch(() => false);
        }
      },
      async remove(oid) {
        await files.remove(partsDir(oid)).catch(() => false);
      },
    },
  };
}

/** The store of a repository (its files and root: the .git directory, or the SQL store's files). */
export function repoLfsStore(repo: Repository): LfsStore {
  const access = repo.objects.gc;
  if (!access) throw new Error("this repository's store has no files for LFS objects");
  return lfsStore(access.files, access.root);
}

/** git lfs clean: the content stored, its pointer returned (an empty input is its own pointer) */
export async function clean(
  store: LfsStore,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<{ pointer: Uint8Array } & Pointer> {
  const p = await store.put(source);
  return { ...p, pointer: encodePointer(p) };
}

/** git lfs smudge: a pointer's content; anything else (an empty blob included) unchanged */
export async function* smudge(store: LfsStore, blob: Uint8Array): AsyncGenerator<Uint8Array> {
  const p = blob.length <= MAX_POINTER_SIZE ? parsePointer(blob) : undefined;
  if (!p || p.size === 0) {
    yield blob;
    return;
  }
  const size = await store.size(p.oid);
  if (size === undefined) throw new Error(`lfs object ${p.oid} not found`);
  if (size !== p.size)
    throw new LfsVerifyError(`lfs object ${p.oid}: ${size} bytes, pointer says ${p.size}`);
  yield* store.read(p.oid);
}
