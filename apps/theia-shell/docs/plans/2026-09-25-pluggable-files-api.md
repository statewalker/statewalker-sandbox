# Pluggable FilesApi: mount points and a secret vault — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The theia-shell app's file system becomes a filterable composite of user-defined mount points (memory, OPFS, local folder, S3) over a main persistent storage that holds the settings and a password-protected, WebCrypto-encrypted secret vault.

**Architecture:** Three new Theia extensions — `theia-secret-vault` (vault + Theia `KeyStoreService`), `theia-files-mounts` (mount types, mount table, layers, main storage, settings relocation, UI) and `theia-files-s3` (the S3 type) — plus small changes to `theia-files-api` (change notifications) and `app/files` (defaults). Every backend is an existing `@statewalker/webrun-files-*` 0.10.0 class; this work only adapts configs to constructors. Pure logic lives in `src/common` and is unit-tested in Node; Theia wiring lives in `src/browser` and is covered by Playwright against the static build.

**Tech Stack:** Theia 1.76.0 (browser-only), TypeScript 5.9 (CommonJS output), `@statewalker/webrun-files{,-mem,-browser,-composite,-s3}` 0.10.0, `@aws-sdk/client-s3` 3.1140.0, WebCrypto, IndexedDB, vitest 4, Playwright 1.56, RustFS `rustfs/rustfs:1.0.0-beta.8` in Docker.

**Spec:** `apps/theia-shell/docs/specs/2026-09-25-pluggable-files-api-design.md` (read it first; this plan argues from it).

All paths below are relative to `apps/theia-shell/` unless they start with `/`.

## Global Constraints

- Exact version pins, as the existing packages do: `@theia/*` `1.76.0`; `@statewalker/webrun-files*` `0.10.0`; `@aws-sdk/client-s3` `3.1140.0`.
- Packages compile with `tsc -p tsconfig.json` extending `../../tsconfig.theia.json` (CommonJS, `moduleResolution: node`); `src/` → `lib/`; unit tests in `tests/**/*.test.ts`, vitest, `environment: "node"`.
- Every new Theia extension declares `theiaExtensions` with both `frontend` and `frontendOnly` pointing at its `lib/browser/*-frontend-module`.
- Every new package is added to `app/package.json` `dependencies` **and** to the package filter list in `app/package.json`'s `build` and `build:prod` scripts (they build packages explicitly before `theia build`).
- Crypto: PBKDF2 / SHA-256 / **600 000** iterations / 16-byte random salt; AES-GCM 256; 12-byte random IV per encryption; the data key is non-extractable once unlocked.
- Vault files, in the main storage: `/.shell/vault.key.json`, `/.shell/secrets.json`; Theia config dir: `/.shell/settings/`, served as `shell-system:///`.
- Preferences: `files.mounts` (array of `MountConfig`, user scope), `files.hidden` (array of globs, user scope).
- Mount secrets: `CredentialsService` service `theia-shell.mounts`, account `<key>/<field>`.
- IndexedDB databases: `theia-shell-boot` (main storage), `theia-shell-vault-keys` (remembered password keys), `theia-shell-handles` (local-folder handles); one object store `entries` each.
- App e2e port 3100 (origin `http://127.0.0.1:3100`); RustFS fixture ports 19100 (unit) and 19101 (e2e).
- Red → green, as PLAN.md's *Method*: every test is run failing before the code that makes it pass; record the red and green counts in the package README's *Red / green* section at the end of each task.
- Commits: `theia-shell: <what>` plus the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. `npx -y @biomejs/biome@2.5.11 check apps/theia-shell` (from the repo root) is clean before every commit.

## Decisions made while planning (the spec is updated with them in Task 0)

1. `UserStorageContribution.getDelegate()` hard-codes the `file` provider; it is rebound to a subclass that activates `shell-system` (already in the spec).
2. **The root never waits for preferences.** Theia's folder-scope preferences read `file:///.theia/settings.json` *through* the root; if the root waited for `PreferenceService.ready` the app would deadlock. So `MountService.start()` resolves once the main storage is open (main mount only); `files.mounts` is applied when preferences are ready and reported as changes.
3. `MountField.kind` is `"text" | "secret" | "url"`. Picking a folder is not a field: a `MountType` may implement `configure(mount)` — an interactive step after the fields (the local folder type opens the directory picker there). The local-folder handle is stored under a random `handleId` kept in the mount's `config`, so a key rename does not lose it.
4. A `MountField.default` may be a function of the mount (`(m) => m.key` for OPFS `directory`), and the wizard writes the value into `config`, so the OPFS storage name survives key renames.
5. `SecretVault` merges on write (re-reads `secrets.json` before each change), so two tabs do not erase each other's secrets.
6. The in-memory mount type has no config fields, so "editing an in-memory mount's config" cannot happen; the spec's wizard warning for it is dropped as vacuous.

## Review Focus

1. A hand-edited `settings.json` whose `files.mounts` is not an array, or has an entry with no key, a duplicate key, an unknown type or a secret in `config` → each bad entry is skipped with one warning, and the valid entries still mount (Task 5 `validateMountConfigs` tests, Task 9 e2e).
2. Two tabs of the app open on the same main storage, each saving a different secret → both secrets survive (Task 3 "merge on write" test).
3. Mount names in non-Latin scripts ("Мой диск", "東京") → key `mount`, then `mount-2`; the name itself shows unchanged in the explorer (Task 5 key tests, Task 9 e2e).
4. Passwords with spaces, accents or emoji → used exactly as typed (never trimmed); an empty password is refused when creating the vault (Task 3 test, Task 4 dialog validation).
5. An S3 endpoint typed as `localhost:9000`, `http://host:9000/` or with a path → a value that is not an `http(s)` URL is refused in the wizard; a trailing slash is removed (Task 10 `s3ClientOptions` tests).

---

### Task 0: Setup and spec alignment

**Files:**
- Modify: `docs/specs/2026-09-25-pluggable-files-api-design.md`

- [ ] **Step 1: Install and establish the green baseline**

Run (from `apps/theia-shell`):
```bash
pnpm install && pnpm build && pnpm test
```
Expected: every package builds; 57 unit tests pass.

- [ ] **Step 2: Apply the planning decisions to the spec**

In the spec:
- In *Data flow* step 1, replace "`FilesApiSource` resolves → `MountService` mounts main, reads `files.mounts` (or the defaults), creates the other mounts" with: "`FilesApiSource` resolves with the main mount only → when preferences are ready, `MountService` reads `files.mounts` (or the defaults) and creates the other mounts, reported as changes (the root never waits for preferences: folder-scope preferences are read through it)".
- In the `MountField` interface, change `kind` to `"text" | "secret" | "url"`, change `default?: string` to `default?: string | ((mount: { key: string; name: string }) => string)`, and add to `MountType`: `configure?(mount: MountConfig): Promise<Record<string, string> | undefined>; // interactive step after the fields (folder picker)` and `forget?(mount: MountConfig): Promise<void>; // on unmount`.
- In *Built-in types*, local folder: "no field; `configure` opens the directory picker and stores the handle in IndexedDB under a random `handleId` kept in `config`, so renaming the key keeps it".
- In *Keys*, delete the bullet "Editing a type's config re-creates the mount; for an in-memory mount that means empty, and the wizard says so before applying." and add: "Editing a type's config re-creates the mount."

- [ ] **Step 3: Commit**

```bash
git add docs/specs/2026-09-25-pluggable-files-api-design.md
git commit -m "theia-shell: spec — decisions from planning

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: RustFS fixture with browser CORS

**Files:**
- Create: `tools/rustfs.mjs`
- Create: `packages/theia-files-s3/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`
- Test: `packages/theia-files-s3/tests/rustfs-fixture.test.ts`

**Interfaces:**
- Produces: `tools/rustfs.mjs` exports `hasDocker(): boolean`, `startRustFs({ port, origin, bucket? }): Promise<{ endpoint, accessKeyId, secretAccessKey, bucket, client, stop() }>`, `S3_BROWSER_HEADERS: string[]`.

- [ ] **Step 1: Create the package skeleton**

`packages/theia-files-s3/package.json`:
```json
{
  "name": "@theia-shell/theia-files-s3",
  "version": "0.0.0",
  "private": true,
  "description": "Theia extension: an S3 mount type for @theia-shell/theia-files-mounts (webrun-files-s3).",
  "main": "lib/common/index.js",
  "types": "lib/common/index.d.ts",
  "files": ["lib", "src"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "3.1140.0",
    "@statewalker/webrun-files": "0.10.0",
    "@statewalker/webrun-files-s3": "0.10.0",
    "@theia/core": "1.76.0"
  }
}
```
`tsconfig.json`:
```json
{
  "extends": "../../tsconfig.theia.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib" },
  "include": ["src"]
}
```
`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 60_000 },
});
```
Create `src/common/index.ts` containing `export {};` so the build has an entry. Run `pnpm install` from `apps/theia-shell`.

- [ ] **Step 2: Write the failing test**

`packages/theia-files-s3/tests/rustfs-fixture.test.ts`:
```ts
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module shared with the Playwright tests
import { hasDocker, startRustFs } from "../../../tools/rustfs.mjs";

const ORIGIN = "http://127.0.0.1:3100";
const itDocker = hasDocker() ? it : it.skip;

describe("RustFS fixture", () => {
  itDocker("allows a signed browser request from the test origin", async () => {
    const s3 = await startRustFs({ port: 19100, origin: ORIGIN });
    try {
      const res = await fetch(`${s3.endpoint}/${s3.bucket}/probe.txt`, {
        method: "OPTIONS",
        headers: {
          Origin: ORIGIN,
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers":
            "authorization,x-amz-date,x-amz-content-sha256,amz-sdk-invocation-id",
        },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      const allowed = (res.headers.get("access-control-allow-headers") ?? "")
        .toLowerCase()
        .split(/\s*,\s*/);
      // A "*" would not do: it never covers Authorization (Fetch spec).
      for (const header of ["authorization", "x-amz-date", "x-amz-content-sha256", "amz-sdk-invocation-id"]) {
        expect(allowed).toContain(header);
      }
    } finally {
      s3.stop();
    }
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Create `tools/rustfs.mjs` with only `export function hasDocker() { return true; } export async function startRustFs() { throw new Error("not implemented"); }`.
Run: `pnpm --filter @theia-shell/theia-files-s3 test`
Expected: FAIL — "not implemented".

- [ ] **Step 4: Implement the fixture**

`tools/rustfs.mjs`:
```js
// An S3-compatible server for tests: RustFS in Docker, with one bucket whose
// CORS rule lets the app (a browser page on `origin`) sign requests to it.
import { execFileSync } from "node:child_process";
import { CreateBucketCommand, PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";

export const RUSTFS_IMAGE = "rustfs/rustfs:1.0.0-beta.8";

/** Headers the AWS SDK sends from a browser. Listed, not "*": a wildcard never covers Authorization. */
export const S3_BROWSER_HEADERS = [
  "authorization",
  "content-type",
  "content-length",
  "content-md5",
  "x-amz-date",
  "x-amz-content-sha256",
  "x-amz-user-agent",
  "x-amz-checksum-crc32",
  "x-amz-sdk-checksum-algorithm",
  "amz-sdk-invocation-id",
  "amz-sdk-request",
];

export function hasDocker() {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ port: number, origin: string, bucket?: string }} options
 */
export async function startRustFs({ port, origin, bucket = "theia-shell" }) {
  const name = `theia-shell-rustfs-${port}`;
  const accessKeyId = "theiashell";
  const secretAccessKey = "theiashell-secret";
  execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  execFileSync(
    "docker",
    [
      "run", "-d", "--name", name, "-p", `127.0.0.1:${port}:9000`,
      "-e", `RUSTFS_ACCESS_KEY=${accessKeyId}`,
      "-e", `RUSTFS_SECRET_KEY=${secretAccessKey}`,
      RUSTFS_IMAGE,
    ],
    { stdio: "ignore" },
  );
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  await retry(() => client.send(new CreateBucketCommand({ Bucket: bucket })));
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [origin],
            AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
            AllowedHeaders: S3_BROWSER_HEADERS,
            ExposeHeaders: ["ETag", "x-amz-version-id"],
            MaxAgeSeconds: 600,
          },
        ],
      },
    }),
  );
  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    client,
    stop() {
      client.destroy();
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    },
  };
}

async function retry(fn, attempts = 40) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw last;
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm --filter @theia-shell/theia-files-s3 test`
Expected: PASS (1 test), or SKIPPED with Docker absent. If the header assertion fails, print `res.headers` and adjust `S3_BROWSER_HEADERS`; do not replace the list with `"*"`.

- [ ] **Step 6: README and commit**

`packages/theia-files-s3/README.md`: title, one paragraph ("the S3 mount type; separate because `@aws-sdk/client-s3` is large"), a *Tests* section naming the RustFS fixture and the CORS finding (explicit header list), and *Red / green* with this task's counts.

```bash
git add tools/rustfs.mjs packages/theia-files-s3 pnpm-lock.yaml
git commit -m "theia-shell: RustFS fixture whose bucket lets the app sign requests

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `theia-files-api` reports external changes

**Files:**
- Modify: `packages/theia-files-api/src/common/files-api-source.ts`
- Modify: `packages/theia-files-api/src/common/files-api-fs-provider.ts` (add `notifyChanges`, `toFileChanges`)
- Modify: `packages/theia-files-api/src/browser/files-api-frontend-module.ts:32-38`
- Test: `packages/theia-files-api/tests/files-api-changes.test.ts`

**Interfaces:**
- Produces (from `@theia-shell/theia-files-api`):
  - `interface FilesApiChange { type: "added" | "updated" | "deleted"; path: string }`
  - `const FilesApiChanges: symbol; type FilesApiChanges = Event<readonly FilesApiChange[]>` — optional binding; when bound, the provider forwards it.
  - `FilesApiFileSystemProvider.notifyChanges(changes: readonly FileChange[]): void`
  - `toFileChanges(root: string, changes: readonly FilesApiChange[]): FileChange[]`

- [ ] **Step 1: Write the failing test**

`packages/theia-files-api/tests/files-api-changes.test.ts`:
```ts
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { FileChange } from "@theia/filesystem/lib/common/files";
import { describe, expect, it } from "vitest";
import { ChangeType } from "../src/common/const-enums";
import { FilesApiFileSystemProvider, toFileChanges } from "../src/common/files-api-fs-provider";

describe("external changes", () => {
  it("maps FilesApi paths to URIs under the root", () => {
    const changes = toFileChanges("file:///", [
      { type: "added", path: "/cloud" },
      { type: "deleted", path: "/old" },
      { type: "updated", path: "/" },
    ]);
    expect(changes.map((c) => [c.type, c.resource.toString()])).toEqual([
      [ChangeType.ADDED, "file:///cloud"],
      [ChangeType.DELETED, "file:///old"],
      [ChangeType.UPDATED, "file:///"],
    ]);
  });

  it("fires them through the provider's change event", () => {
    const provider = new FilesApiFileSystemProvider(new MemFilesApi());
    const seen: FileChange[] = [];
    provider.onDidChangeFile((changes) => seen.push(...changes));
    provider.notifyChanges(toFileChanges("file:///", [{ type: "added", path: "/cloud" }]));
    provider.notifyChanges([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].resource.path.toString()).toBe("/cloud");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @theia-shell/theia-files-api exec vitest run tests/files-api-changes.test.ts`
Expected: FAIL — `toFileChanges` is not exported.

- [ ] **Step 3: Implement**

Append to `src/common/files-api-source.ts`:
```ts
import type { Event } from "@theia/core/lib/common/event";

/** A change made to the FilesApi by someone other than the Theia provider. */
export interface FilesApiChange {
  type: "added" | "updated" | "deleted";
  path: string;
}

/**
 * Optional DI key: an event of changes the provider cannot see (a mount
 * appearing, a filter changing). When bound, the provider forwards it to Theia.
 */
export const FilesApiChanges = Symbol("FilesApiChanges");
export type FilesApiChanges = Event<readonly FilesApiChange[]>;
```
(Move the existing `import type { FilesApi }` line to stay first; biome sorts imports.)

In `src/common/files-api-fs-provider.ts`: change `import type URI from "@theia/core/lib/common/uri";` to `import URI from "@theia/core/lib/common/uri";`, add `import type { FilesApiChange } from "./files-api-source";`, add this method to the class after `watch()`:
```ts
  /** Reports changes made to the FilesApi outside this provider (see `FilesApiChanges`). */
  notifyChanges(changes: readonly FileChange[]): void {
    if (changes.length > 0) this.changes.fire(changes);
  }
```
and this function after the class:
```ts
const CHANGE_TYPES = {
  added: ChangeType.ADDED,
  updated: ChangeType.UPDATED,
  deleted: ChangeType.DELETED,
} as const;

/** FilesApi paths → Theia file changes under `root` (e.g. `file:///`). */
export function toFileChanges(root: string, changes: readonly FilesApiChange[]): FileChange[] {
  const base = new URI(root);
  return changes.map((change) => ({
    type: CHANGE_TYPES[change.type],
    resource: base.withPath(change.path),
  }));
}
```
In `src/browser/files-api-frontend-module.ts`, replace the `FilesApiFileSystemProvider` binding with:
```ts
  bind(FilesApiFileSystemProvider)
    .toDynamicValue(({ container }) => {
      const source = container.get<FilesApiSource>(FilesApiSource);
      const provider = new FilesApiFileSystemProvider(() => source());
      if (container.isBound(FilesApiChanges)) {
        const root = container.get<FilesApiWorkspaceRoot>(FilesApiWorkspaceRoot);
        container.get<FilesApiChanges>(FilesApiChanges)((changes) =>
          provider.notifyChanges(toFileChanges(root, changes)),
        );
      }
      return provider;
    })
    .inSingletonScope();
```
and import `FilesApiChanges` from `../common/files-api-source` and `toFileChanges` from `../common/files-api-fs-provider`.

- [ ] **Step 4: Run all package tests**

Run: `pnpm --filter @theia-shell/theia-files-api test && pnpm --filter @theia-shell/theia-files-api build`
Expected: 23 passed; build clean.

- [ ] **Step 5: README and commit**

In `packages/theia-files-api/README.md`, document `FilesApiChanges` in the DI keys list, and record red/green.
```bash
git add packages/theia-files-api
git commit -m "theia-shell: theia-files-api forwards changes it cannot see

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `SecretVault` — the encrypted vault over a FilesApi

**Files:**
- Create: `packages/theia-secret-vault/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/theia-secret-vault/src/common/bytes.ts`
- Create: `packages/theia-secret-vault/src/common/secret-vault.ts`
- Create: `packages/theia-secret-vault/src/common/index.ts`
- Test: `packages/theia-secret-vault/tests/secret-vault.test.ts`

**Interfaces:**
- Produces:
  - `class SecretVault(files: FilesApi, dir: string, options?: { iterations?: number })` with
    `unlocked: boolean`, `id(): Promise<string | undefined>`, `exists(): Promise<boolean>`,
    `create(password): Promise<CryptoKey>` (returns the password key), `unlock(password): Promise<CryptoKey>`,
    `unlockWithKey(passwordKey): Promise<void>`, `openSession(): Promise<void>`, `lock(): void`,
    `changePassword(newPassword): Promise<CryptoKey>`, `reset(newPassword): Promise<CryptoKey>`,
    `get(name): string | undefined`, `names(): string[]`, `set(name, value): Promise<void>`,
    `delete(name): Promise<boolean>`, `onDidChangeLock: Event<boolean>` (true = unlocked).
  - Errors: `WrongPasswordError`, `VaultLockedError`, `VaultCorruptError`.
  - Constants: `VAULT_KEY_FILE = "vault.key.json"`, `SECRETS_FILE = "secrets.json"`, `DEFAULT_ITERATIONS = 600_000`.

- [ ] **Step 1: Package skeleton**

`packages/theia-secret-vault/package.json`:
```json
{
  "name": "@theia-shell/theia-secret-vault",
  "version": "0.0.0",
  "private": true,
  "description": "Theia extension: a password-protected, WebCrypto-encrypted secret vault behind Theia's KeyStoreService.",
  "main": "lib/common/index.js",
  "types": "lib/common/index.d.ts",
  "files": ["lib", "src"],
  "theiaExtensions": [
    {
      "frontend": "lib/browser/vault-frontend-module",
      "frontendOnly": "lib/browser/vault-frontend-module"
    }
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@statewalker/webrun-files": "0.10.0",
    "@statewalker/webrun-files-mem": "0.10.0",
    "@theia/core": "1.76.0"
  }
}
```
`tsconfig.json` and `vitest.config.ts`: as in Task 1 (vitest without `testTimeout`). The `theiaExtensions` module is created in Task 4; until then do not add this package to the app.

- [ ] **Step 2: Write the failing tests**

`packages/theia-secret-vault/tests/secret-vault.test.ts`:
```ts
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SECRETS_FILE,
  SecretVault,
  VAULT_KEY_FILE,
  VaultCorruptError,
  VaultLockedError,
  WrongPasswordError,
} from "../src/common/secret-vault";

const FAST = { iterations: 1000 };
let files: MemFilesApi;
const vault = () => new SecretVault(files, "/.shell", FAST);

beforeEach(() => {
  files = new MemFilesApi();
});

describe("SecretVault", () => {
  it("creates a vault and unlocks it again with the same password", async () => {
    const a = vault();
    await a.create("correct horse");
    await a.set("s3/key", "AKIA-SECRET");
    const b = vault();
    expect(b.unlocked).toBe(false);
    await b.unlock("correct horse");
    expect(b.get("s3/key")).toBe("AKIA-SECRET");
  });

  it("rejects a wrong password and stays locked", async () => {
    await vault().create("right");
    const b = vault();
    await expect(b.unlock("wrong")).rejects.toBeInstanceOf(WrongPasswordError);
    expect(b.unlocked).toBe(false);
  });

  it("uses passwords exactly as typed", async () => {
    await vault().create("  pässwörd 🔑 ");
    await expect(vault().unlock("pässwörd 🔑")).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(vault().unlock("  pässwörd 🔑 ")).resolves.toBeDefined();
  });

  it("never writes a secret's name or value in clear", async () => {
    const a = vault();
    await a.create("pw");
    await a.set("cloud/secretAccessKey", "very-secret-value");
    const raw = (await readText(files, `/.shell/${SECRETS_FILE}`)) + (await readText(files, `/.shell/${VAULT_KEY_FILE}`));
    expect(raw).not.toContain("very-secret-value");
    expect(raw).not.toContain("cloud/secretAccessKey");
  });

  it("changes the password without touching the secrets file", async () => {
    const a = vault();
    await a.create("old");
    await a.set("x", "1");
    const before = await readText(files, `/.shell/${SECRETS_FILE}`);
    await a.changePassword("new");
    expect(await readText(files, `/.shell/${SECRETS_FILE}`)).toBe(before);
    await expect(vault().unlock("old")).rejects.toBeInstanceOf(WrongPasswordError);
    const b = vault();
    await b.unlock("new");
    expect(b.get("x")).toBe("1");
  });

  it("unlocks with a remembered, non-extractable password key", async () => {
    const key = await vault().create("pw");
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toBeDefined();
    const b = vault();
    await b.unlockWithKey(key);
    expect(b.unlocked).toBe(true);
  });

  it("reset makes a new, empty vault", async () => {
    const a = vault();
    await a.create("forgotten");
    await a.set("x", "1");
    const b = vault();
    await b.reset("fresh");
    expect(b.get("x")).toBeUndefined();
    await expect(vault().unlock("forgotten")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("refuses a tampered secrets file and leaves it alone", async () => {
    const a = vault();
    await a.create("pw");
    await a.set("x", "1");
    const path = `/.shell/${SECRETS_FILE}`;
    const file = JSON.parse(await readText(files, path));
    file.data = `${file.data.slice(0, -4)}AAAA`;
    await writeText(files, path, JSON.stringify(file));
    const tampered = await readText(files, path);
    const b = vault();
    await expect(b.unlock("pw")).rejects.toBeInstanceOf(VaultCorruptError);
    expect(b.unlocked).toBe(false);
    expect(await readText(files, path)).toBe(tampered);
  });

  it("refuses a secrets file from another vault", async () => {
    const other = new MemFilesApi();
    const o = new SecretVault(other, "/.shell", FAST);
    await o.create("pw");
    await o.set("x", "1");
    await vault().create("pw");
    await writeText(files, `/.shell/${SECRETS_FILE}`, await readText(other, `/.shell/${SECRETS_FILE}`));
    await expect(vault().unlock("pw")).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it("returns nothing and refuses writes while locked", async () => {
    await vault().create("pw");
    const b = vault();
    expect(b.get("x")).toBeUndefined();
    await expect(b.set("x", "1")).rejects.toBeInstanceOf(VaultLockedError);
    const a = vault();
    await a.unlock("pw");
    a.lock();
    expect(a.unlocked).toBe(false);
    expect(a.get("x")).toBeUndefined();
  });

  it("keeps both secrets when two instances write in turn (two tabs)", async () => {
    await vault().create("pw");
    const tab1 = vault();
    const tab2 = vault();
    await tab1.unlock("pw");
    await tab2.unlock("pw");
    await tab1.set("a", "1");
    await tab2.set("b", "2");
    const check = vault();
    await check.unlock("pw");
    expect(check.get("a")).toBe("1");
    expect(check.get("b")).toBe("2");
  });

  it("opens an unpersisted session vault without a password", async () => {
    const a = vault();
    await a.openSession();
    await a.set("x", "1");
    expect(a.get("x")).toBe("1");
    expect(await a.exists()).toBe(false);
  });

  it("reports lock changes", async () => {
    const a = vault();
    const seen: boolean[] = [];
    a.onDidChangeLock((unlocked) => seen.push(unlocked));
    await a.create("pw");
    a.lock();
    expect(seen).toEqual([true, false]);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @theia-shell/theia-secret-vault test`
Expected: FAIL — cannot resolve `../src/common/secret-vault`.

- [ ] **Step 4: Implement**

`src/common/bytes.ts`:
```ts
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}
```

`src/common/secret-vault.ts`:
```ts
import { type FilesApi, joinPath, tryReadText, writeText } from "@statewalker/webrun-files";
import { Emitter, type Event } from "@theia/core/lib/common/event";
import { fromBase64, randomBytes, toBase64, utf8 } from "./bytes";

export const VAULT_KEY_FILE = "vault.key.json";
export const SECRETS_FILE = "secrets.json";
export const DEFAULT_ITERATIONS = 600_000;

export class WrongPasswordError extends Error {
  constructor() {
    super("Wrong password");
    this.name = "WrongPasswordError";
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super("Secrets are locked");
    this.name = "VaultLockedError";
  }
}

export class VaultCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultCorruptError";
  }
}

interface VaultKeyFile {
  version: 1;
  id: string;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  wrap: { name: "AES-GCM"; iv: string };
  wrappedKey: string;
}

interface SecretsFile {
  version: 1;
  iv: string;
  data: string;
}

export interface SecretVaultOptions {
  /** PBKDF2 iterations for new keys; tests lower it. */
  iterations?: number;
}

/**
 * Secrets in `<dir>/secrets.json`, encrypted as a whole with a random AES-GCM
 * data key; the data key sits in `<dir>/vault.key.json`, wrapped by a key
 * derived from the user's password (PBKDF2). Unlocked, the data key is held
 * non-extractable. Writes re-read the file first, so two tabs do not erase
 * each other's secrets.
 */
export class SecretVault {
  protected dataKey: CryptoKey | undefined;
  protected passwordKey: CryptoKey | undefined;
  protected keyFile: VaultKeyFile | undefined;
  protected sessionId: string | undefined;
  protected secrets = new Map<string, string>();
  protected readonly lockEmitter = new Emitter<boolean>();
  /** Fires `true` when the vault unlocks, `false` when it locks. */
  readonly onDidChangeLock: Event<boolean> = this.lockEmitter.event;
  protected readonly iterations: number;

  constructor(
    protected readonly files: FilesApi,
    protected readonly dir: string,
    options: SecretVaultOptions = {},
  ) {
    this.iterations = options.iterations ?? DEFAULT_ITERATIONS;
  }

  get unlocked(): boolean {
    return this.dataKey !== undefined;
  }

  async id(): Promise<string | undefined> {
    return (await this.readKeyFile())?.id ?? this.sessionId;
  }

  async exists(): Promise<boolean> {
    return (await this.readKeyFile()) !== undefined;
  }

  async create(password: string): Promise<CryptoKey> {
    if (await this.exists()) throw new Error("A vault already exists here");
    return this.createVault(password);
  }

  async unlock(password: string): Promise<CryptoKey> {
    const file = await this.requireKeyFile();
    const passwordKey = await derivePasswordKey(password, fromBase64(file.kdf.salt), file.kdf.iterations);
    await this.unlockWithKey(passwordKey);
    return passwordKey;
  }

  async unlockWithKey(passwordKey: CryptoKey): Promise<void> {
    const file = await this.requireKeyFile();
    const dataKey = await unwrapDataKey(file, passwordKey, false);
    const secrets = await this.readSecrets(dataKey, file.id);
    this.keyFile = file;
    this.passwordKey = passwordKey;
    this.dataKey = dataKey;
    this.secrets = secrets;
    this.lockEmitter.fire(true);
  }

  /** A vault for an in-memory main storage: random key, no password, nothing persisted beyond `files`. */
  async openSession(): Promise<void> {
    this.sessionId = crypto.randomUUID();
    this.dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    this.secrets = new Map();
    this.lockEmitter.fire(true);
  }

  lock(): void {
    if (!this.dataKey) return;
    this.dataKey = undefined;
    this.passwordKey = undefined;
    this.secrets = new Map();
    this.lockEmitter.fire(false);
  }

  async changePassword(newPassword: string): Promise<CryptoKey> {
    const file = this.keyFile;
    const oldKey = this.passwordKey;
    if (!file || !oldKey) throw new VaultLockedError();
    const exportable = await unwrapDataKey(file, oldKey, true);
    const { file: next, passwordKey } = await wrapDataKey(exportable, newPassword, file.id, this.iterations);
    await writeText(this.files, this.path(VAULT_KEY_FILE), JSON.stringify(next, null, 2));
    this.keyFile = next;
    this.passwordKey = passwordKey;
    return passwordKey;
  }

  async reset(newPassword: string): Promise<CryptoKey> {
    await this.files.remove(this.path(VAULT_KEY_FILE));
    await this.files.remove(this.path(SECRETS_FILE));
    this.lock();
    return this.createVault(newPassword);
  }

  /** The secret, or undefined when absent or locked. */
  get(name: string): string | undefined {
    return this.secrets.get(name);
  }

  names(): string[] {
    return [...this.secrets.keys()];
  }

  async set(name: string, value: string): Promise<void> {
    await this.update((secrets) => {
      secrets.set(name, value);
      return true;
    });
  }

  async delete(name: string): Promise<boolean> {
    let removed = false;
    await this.update((secrets) => {
      removed = secrets.delete(name);
      return removed;
    });
    return removed;
  }

  protected async update(change: (secrets: Map<string, string>) => boolean): Promise<void> {
    const dataKey = this.dataKey;
    if (!dataKey) throw new VaultLockedError();
    const id = (await this.id()) as string;
    const secrets = await this.readSecrets(dataKey, id);
    if (!change(secrets)) {
      this.secrets = secrets;
      return;
    }
    await this.writeSecrets(dataKey, id, secrets);
    this.secrets = secrets;
  }

  protected async createVault(password: string): Promise<CryptoKey> {
    const id = crypto.randomUUID();
    const exportable = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const { file, passwordKey } = await wrapDataKey(exportable, password, id, this.iterations);
    await writeText(this.files, this.path(VAULT_KEY_FILE), JSON.stringify(file, null, 2));
    const dataKey = await unwrapDataKey(file, passwordKey, false);
    await this.writeSecrets(dataKey, id, new Map());
    this.keyFile = file;
    this.passwordKey = passwordKey;
    this.dataKey = dataKey;
    this.secrets = new Map();
    this.lockEmitter.fire(true);
    return passwordKey;
  }

  protected async readSecrets(dataKey: CryptoKey, id: string): Promise<Map<string, string>> {
    const text = await tryReadText(this.files, this.path(SECRETS_FILE));
    if (text === undefined) return new Map();
    try {
      const file = JSON.parse(text) as SecretsFile;
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(file.iv), additionalData: utf8(id) },
        dataKey,
        fromBase64(file.data),
      );
      return new Map(Object.entries(JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>));
    } catch {
      throw new VaultCorruptError(`${SECRETS_FILE} cannot be decrypted with this vault's key`);
    }
  }

  protected async writeSecrets(dataKey: CryptoKey, id: string, secrets: Map<string, string>): Promise<void> {
    const iv = randomBytes(12);
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(id) },
      dataKey,
      utf8(JSON.stringify(Object.fromEntries(secrets))),
    );
    const file: SecretsFile = { version: 1, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
    await writeText(this.files, this.path(SECRETS_FILE), JSON.stringify(file));
  }

  protected async readKeyFile(): Promise<VaultKeyFile | undefined> {
    const text = await tryReadText(this.files, this.path(VAULT_KEY_FILE));
    return text === undefined ? undefined : (JSON.parse(text) as VaultKeyFile);
  }

  protected async requireKeyFile(): Promise<VaultKeyFile> {
    const file = await this.readKeyFile();
    if (!file) throw new Error("No vault here yet");
    return file;
  }

  protected path(name: string): string {
    return joinPath(this.dir, name);
  }
}

async function derivePasswordKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

async function wrapDataKey(dataKey: CryptoKey, password: string, id: string, iterations: number) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const passwordKey = await derivePasswordKey(password, salt, iterations);
  const wrapped = await crypto.subtle.wrapKey("raw", dataKey, passwordKey, {
    name: "AES-GCM",
    iv,
    additionalData: utf8(id),
  });
  const file: VaultKeyFile = {
    version: 1,
    id,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toBase64(salt) },
    wrap: { name: "AES-GCM", iv: toBase64(iv) },
    wrappedKey: toBase64(new Uint8Array(wrapped)),
  };
  return { file, passwordKey };
}

async function unwrapDataKey(file: VaultKeyFile, passwordKey: CryptoKey, extractable: boolean): Promise<CryptoKey> {
  try {
    return await crypto.subtle.unwrapKey(
      "raw",
      fromBase64(file.wrappedKey),
      passwordKey,
      { name: "AES-GCM", iv: fromBase64(file.wrap.iv), additionalData: utf8(file.id) },
      { name: "AES-GCM", length: 256 },
      extractable,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw new WrongPasswordError();
  }
}
```

`src/common/index.ts`:
```ts
export * from "./secret-vault";
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @theia-shell/theia-secret-vault test && pnpm --filter @theia-shell/theia-secret-vault build`
Expected: 13 passed; build clean. (If `tsc` rejects a `Uint8Array` as `BufferSource`, the helper's return type must stay `Uint8Array<ArrayBuffer>`; do not cast to `any`.)

- [ ] **Step 6: Commit**

```bash
git add packages/theia-secret-vault pnpm-lock.yaml
git commit -m "theia-shell: SecretVault — secrets encrypted under a password-wrapped key

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The vault in Theia — `KeyStoreService`, unlock dialog, commands

**Files:**
- Create: `packages/theia-secret-vault/src/common/vault-key-store.ts`
- Create: `packages/theia-secret-vault/src/browser/idb-store.ts`
- Create: `packages/theia-secret-vault/src/browser/vault-service.ts`
- Create: `packages/theia-secret-vault/src/browser/vault-dialog.ts`
- Create: `packages/theia-secret-vault/src/browser/vault-contribution.ts`
- Create: `packages/theia-secret-vault/src/browser/vault-frontend-module.ts`
- Create: `packages/theia-secret-vault/src/browser/style/vault.css`
- Create: `packages/theia-secret-vault/README.md`
- Modify: `packages/theia-secret-vault/src/common/index.ts`
- Test: `packages/theia-secret-vault/tests/vault-key-store.test.ts`

**Interfaces:**
- Consumes: `SecretVault`, errors (Task 3).
- Produces:
  - `class VaultKeyStore implements KeyStoreService` (`constructor(vault: () => SecretVault | undefined)`), `entryName(service, account): string`.
  - `class IdbStore<T>(name: string)` with `get(key)`, `set(key, value)`, `delete(key)` — import path `@theia-shell/theia-secret-vault/lib/browser/idb-store`.
  - DI: `VaultLocation` symbol, `type VaultLocation = () => Promise<{ files: FilesApi; dir: string; persistent: boolean }>` (default binding: in-memory, not persistent — the app rebinds it); `VaultService` with `vault(): Promise<SecretVault>`, `current: SecretVault | undefined`, `onDidUnlock: Event<void>`; `VaultUi` with `ensureUnlocked(): Promise<boolean>`.
  - Commands: `secrets.unlock`, `secrets.lock`, `secrets.changePassword`, `secrets.forget`, `secrets.reset`.
  - DOM (for e2e): dialog `.vault-dialog`, inputs `.vault-password`, `.vault-password-confirm`, checkbox `.vault-remember`.

- [ ] **Step 1: Write the failing `KeyStoreService` contract test**

`tests/vault-key-store.test.ts`:
```ts
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { SecretVault, VaultLockedError } from "../src/common/secret-vault";
import { VaultKeyStore } from "../src/common/vault-key-store";

let vault: SecretVault;
let store: VaultKeyStore;

beforeEach(async () => {
  vault = new SecretVault(new MemFilesApi(), "/", { iterations: 1000 });
  await vault.create("pw");
  store = new VaultKeyStore(() => vault);
});

describe("VaultKeyStore (Theia KeyStoreService over the vault)", () => {
  it("stores, reads and deletes by service and account", async () => {
    await store.setPassword("theia-shell.mounts", "cloud/secretAccessKey", "s3cr3t");
    expect(await store.getPassword("theia-shell.mounts", "cloud/secretAccessKey")).toBe("s3cr3t");
    expect(await store.deletePassword("theia-shell.mounts", "cloud/secretAccessKey")).toBe(true);
    expect(await store.getPassword("theia-shell.mounts", "cloud/secretAccessKey")).toBeUndefined();
    expect(await store.deletePassword("theia-shell.mounts", "cloud/secretAccessKey")).toBe(false);
  });

  it("lists one service's accounts, not another's, even with '/' in names", async () => {
    await store.setPassword("a/b", "c", "1");
    await store.setPassword("a", "b/c", "2");
    expect(await store.keys("a")).toEqual(["b/c"]);
    expect(await store.findCredentials("a/b")).toEqual([{ account: "c", password: "1" }]);
    expect(await store.findPassword("a")).toBe("2");
    expect(await store.findPassword("none")).toBeUndefined();
  });

  it("reads nothing and refuses writes while locked", async () => {
    await store.setPassword("s", "a", "1");
    vault.lock();
    expect(await store.getPassword("s", "a")).toBeUndefined();
    expect(await store.findCredentials("s")).toEqual([]);
    await expect(store.setPassword("s", "a", "2")).rejects.toBeInstanceOf(VaultLockedError);
    expect(await store.deletePassword("s", "a")).toBe(false);
  });

  it("works with no vault yet", async () => {
    const none = new VaultKeyStore(() => undefined);
    expect(await none.getPassword("s", "a")).toBeUndefined();
    await expect(none.setPassword("s", "a", "1")).rejects.toBeInstanceOf(VaultLockedError);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @theia-shell/theia-secret-vault exec vitest run tests/vault-key-store.test.ts`
Expected: FAIL — cannot resolve `vault-key-store`.

- [ ] **Step 3: Implement `VaultKeyStore`**

`src/common/vault-key-store.ts`:
```ts
import type { KeyStoreService } from "@theia/core/lib/common/key-store";
import { type SecretVault, VaultLockedError } from "./secret-vault";

/** One vault entry per (service, account); JSON keeps '/' in either unambiguous. */
export function entryName(service: string, account: string): string {
  return JSON.stringify([service, account]);
}

function parseEntryName(name: string): [string, string] | undefined {
  try {
    const parsed = JSON.parse(name);
    return Array.isArray(parsed) && parsed.length === 2 ? (parsed as [string, string]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Theia's `KeyStoreService` (behind `CredentialsService`, and VS Code
 * extensions' `context.secrets`) over the vault. Locked or absent: reads find
 * nothing, writes throw `VaultLockedError`.
 */
export class VaultKeyStore implements KeyStoreService {
  constructor(protected readonly vault: () => SecretVault | undefined) {}

  async setPassword(service: string, account: string, password: string): Promise<void> {
    await this.unlocked().set(entryName(service, account), password);
  }

  async getPassword(service: string, account: string): Promise<string | undefined> {
    return this.vault()?.get(entryName(service, account));
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    const vault = this.vault();
    if (!vault?.unlocked) return false;
    return vault.delete(entryName(service, account));
  }

  async findPassword(service: string): Promise<string | undefined> {
    return (await this.findCredentials(service))[0]?.password;
  }

  async findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
    const vault = this.vault();
    if (!vault?.unlocked) return [];
    const found: Array<{ account: string; password: string }> = [];
    for (const name of vault.names()) {
      const parsed = parseEntryName(name);
      if (parsed?.[0] === service) found.push({ account: parsed[1], password: vault.get(name) as string });
    }
    return found;
  }

  async keys(service: string): Promise<string[]> {
    return (await this.findCredentials(service)).map((c) => c.account);
  }

  protected unlocked(): SecretVault {
    const vault = this.vault();
    if (!vault?.unlocked) throw new VaultLockedError();
    return vault;
  }
}
```
Add `export * from "./vault-key-store";` to `src/common/index.ts`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @theia-shell/theia-secret-vault test`
Expected: 17 passed.

- [ ] **Step 5: Implement the browser side**

`src/browser/idb-store.ts`:
```ts
/** A tiny key–value store: one IndexedDB database per name, one object store `entries`. */
export class IdbStore<T> {
  private db: Promise<IDBDatabase> | undefined;

  constructor(readonly name: string) {}

  get(key: string): Promise<T | undefined> {
    return this.run("readonly", (store) => store.get(key) as IDBRequest<T | undefined>);
  }

  async set(key: string, value: T): Promise<void> {
    await this.run("readwrite", (store) => store.put(value, key));
  }

  async delete(key: string): Promise<void> {
    await this.run("readwrite", (store) => store.delete(key));
  }

  private async run<R>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<R>): Promise<R> {
    this.db ??= openDatabase(this.name);
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const request = op(db.transaction("entries", mode).objectStore("entries"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("entries");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
```

`src/browser/vault-service.ts`:
```ts
import type { FilesApi } from "@statewalker/webrun-files";
import { Emitter, type Event } from "@theia/core/lib/common/event";
import { inject, injectable } from "@theia/core/shared/inversify";
import { SecretVault, WrongPasswordError } from "../common/secret-vault";
import { IdbStore } from "./idb-store";

/** Where the vault lives; the app rebinds it to its main storage's `/.shell`. */
export const VaultLocation = Symbol("VaultLocation");
export type VaultLocation = () => Promise<{ files: FilesApi; dir: string; persistent: boolean }>;

export type SilentUnlock = "unlocked" | "needs-password" | "needs-new-password";

@injectable()
export class VaultService {
  @inject(VaultLocation) protected readonly location!: VaultLocation;

  /** Remembered password keys (non-extractable CryptoKeys), by vault id. */
  protected readonly remembered = new IdbStore<CryptoKey>("theia-shell-vault-keys");
  protected vaultPromise: Promise<SecretVault> | undefined;
  protected persistent = true;
  current: SecretVault | undefined;

  protected readonly unlockEmitter = new Emitter<void>();
  readonly onDidUnlock: Event<void> = this.unlockEmitter.event;

  vault(): Promise<SecretVault> {
    this.vaultPromise ??= this.location().then(({ files, dir, persistent }) => {
      const vault = new SecretVault(files, dir);
      vault.onDidChangeLock((unlocked) => unlocked && this.unlockEmitter.fire());
      this.current = vault;
      this.persistent = persistent;
      return vault;
    });
    return this.vaultPromise;
  }

  /** Unlocks without asking when it can: a session vault, or a remembered key. */
  async unlockSilently(): Promise<SilentUnlock> {
    const vault = await this.vault();
    if (vault.unlocked) return "unlocked";
    if (!this.persistent) {
      await vault.openSession();
      return "unlocked";
    }
    const id = await vault.id();
    if (!id) return "needs-new-password";
    const key = await this.remembered.get(id);
    if (key) {
      try {
        await vault.unlockWithKey(key);
        return "unlocked";
      } catch (error) {
        if (!(error instanceof WrongPasswordError)) throw error;
        await this.remembered.delete(id);
      }
    }
    return "needs-password";
  }

  async remember(passwordKey: CryptoKey): Promise<void> {
    const id = await (await this.vault()).id();
    if (id) await this.remembered.set(id, passwordKey);
  }

  async forget(): Promise<void> {
    const id = await (await this.vault()).id();
    if (id) await this.remembered.delete(id);
  }
}
```

`src/browser/vault-dialog.ts`:
```ts
import { AbstractDialog, DialogError, DialogProps } from "@theia/core/lib/browser/dialogs";

export type VaultDialogMode = "unlock" | "create" | "change";

export class VaultDialogProps extends DialogProps {
  readonly mode!: VaultDialogMode;
  /** Shown above the fields, e.g. "Wrong password. Try again." */
  readonly message?: string;
}

export interface VaultDialogResult {
  password: string;
  remember: boolean;
}

/** Asks for the vault password: to unlock, to create the vault (twice), or a new one. */
export class VaultPasswordDialog extends AbstractDialog<VaultDialogResult> {
  protected readonly password = document.createElement("input");
  protected readonly confirm = document.createElement("input");
  protected readonly rememberBox = document.createElement("input");

  constructor(protected override readonly props: VaultDialogProps) {
    super(props);
    this.addClass("vault-dialog");
    if (props.message) {
      const message = document.createElement("p");
      message.className = "vault-message";
      message.textContent = props.message;
      this.contentNode.appendChild(message);
    }
    this.password.type = "password";
    this.password.className = "theia-input vault-password";
    this.password.placeholder = props.mode === "unlock" ? "Password" : "New password";
    this.contentNode.appendChild(this.password);
    if (props.mode !== "unlock") {
      this.confirm.type = "password";
      this.confirm.className = "theia-input vault-password-confirm";
      this.confirm.placeholder = "Repeat the password";
      this.contentNode.appendChild(this.confirm);
    }
    if (props.mode !== "change") {
      const label = document.createElement("label");
      this.rememberBox.type = "checkbox";
      this.rememberBox.className = "vault-remember";
      label.append(this.rememberBox, " Remember on this device");
      this.contentNode.appendChild(label);
    }
    this.appendCloseButton(props.mode === "change" ? "Cancel" : "Skip");
    this.appendAcceptButton({ unlock: "Unlock", create: "Create", change: "Change" }[props.mode]);
  }

  get value(): VaultDialogResult {
    return { password: this.password.value, remember: this.rememberBox.checked };
  }

  protected override isValid(value: VaultDialogResult): DialogError {
    if (!value.password) return "Enter a password.";
    if (this.props.mode !== "unlock" && value.password !== this.confirm.value) {
      return "The passwords do not match.";
    }
    return "";
  }

  protected override onAfterAttach(msg: Parameters<AbstractDialog<VaultDialogResult>["onAfterAttach"]>[0]): void {
    super.onAfterAttach(msg);
    this.addUpdateListener(this.password, "input");
    this.addUpdateListener(this.confirm, "input");
  }

  protected override onActivateRequest(msg: Parameters<AbstractDialog<VaultDialogResult>["onActivateRequest"]>[0]): void {
    super.onActivateRequest(msg);
    this.password.focus();
  }
}
```

`src/browser/vault-contribution.ts`:
```ts
import { ConfirmDialog } from "@theia/core/lib/browser/dialogs";
import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import type { Command, CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";
import { inject, injectable } from "@theia/core/shared/inversify";
import { WrongPasswordError } from "../common/secret-vault";
import { type VaultDialogMode, VaultPasswordDialog } from "./vault-dialog";
import { VaultService } from "./vault-service";

export namespace VaultCommands {
  const category = "Secrets";
  export const UNLOCK: Command = { id: "secrets.unlock", category, label: "Unlock" };
  export const LOCK: Command = { id: "secrets.lock", category, label: "Lock" };
  export const CHANGE_PASSWORD: Command = { id: "secrets.changePassword", category, label: "Change Password" };
  export const FORGET: Command = { id: "secrets.forget", category, label: "Forget Remembered Password" };
  export const RESET: Command = { id: "secrets.reset", category, label: "Reset Vault" };
}

/** The vault's UI: the unlock-or-create prompt at start, and the commands. */
@injectable()
export class VaultUi implements FrontendApplicationContribution, CommandContribution {
  @inject(VaultService) protected readonly vaults!: VaultService;
  @inject(MessageService) protected readonly messages!: MessageService;

  onDidInitializeLayout(): void {
    void this.ensureUnlocked();
  }

  /** Unlocks, asking when it must. Resolves false if the user skipped. */
  async ensureUnlocked(): Promise<boolean> {
    const state = await this.vaults.unlockSilently();
    if (state === "unlocked") return true;
    return this.prompt(state === "needs-new-password" ? "create" : "unlock");
  }

  protected async prompt(mode: VaultDialogMode): Promise<boolean> {
    const vault = await this.vaults.vault();
    let message: string | undefined;
    for (;;) {
      const title = { create: "Protect your secrets", unlock: "Unlock secrets", change: "Change the secrets password" }[mode];
      const result = await new VaultPasswordDialog({ title, mode, message }).open();
      if (!result) return false;
      try {
        const key =
          mode === "create"
            ? await vault.create(result.password)
            : mode === "unlock"
              ? await vault.unlock(result.password)
              : await vault.changePassword(result.password);
        if (result.remember) await this.vaults.remember(key);
        return true;
      } catch (error) {
        if (error instanceof WrongPasswordError) {
          message = "Wrong password. Try again.";
          continue;
        }
        this.messages.error(`Secrets: ${(error as Error).message}`);
        return false;
      }
    }
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(VaultCommands.UNLOCK, {
      execute: () => this.ensureUnlocked(),
      isEnabled: () => !this.vaults.current?.unlocked,
    });
    commands.registerCommand(VaultCommands.LOCK, {
      execute: () => this.vaults.current?.lock(),
      isEnabled: () => !!this.vaults.current?.unlocked,
    });
    commands.registerCommand(VaultCommands.CHANGE_PASSWORD, {
      execute: () => this.prompt("change"),
      isEnabled: () => !!this.vaults.current?.unlocked,
    });
    commands.registerCommand(VaultCommands.FORGET, { execute: () => this.vaults.forget() });
    commands.registerCommand(VaultCommands.RESET, { execute: () => this.reset() });
  }

  protected async reset(): Promise<void> {
    const confirmed = await new ConfirmDialog({
      title: "Reset the secrets vault?",
      msg: "All stored secrets (S3 keys, …) are deleted and a new password is set. Files and settings are kept.",
      ok: "Reset",
    }).open();
    if (!confirmed) return;
    const result = await new VaultPasswordDialog({ title: "New secrets password", mode: "create" }).open();
    if (!result) return;
    const key = await (await this.vaults.vault()).reset(result.password);
    if (result.remember) await this.vaults.remember(key);
  }
}
```

`src/browser/vault-frontend-module.ts`:
```ts
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { KeyStoreService } from "@theia/core/lib/common/key-store";
import { ContainerModule, type interfaces } from "@theia/core/shared/inversify";
import { VaultKeyStore } from "../common/vault-key-store";
import { VaultUi } from "./vault-contribution";
import { VaultLocation, VaultService } from "./vault-service";
import "./style/vault.css";

/**
 * Browser-only Theia binds `KeyStoreService` to a stub that drops every
 * secret; this module rebinds it to the vault. It loads after @theia/core.
 */
export default new ContainerModule((bind, _unbind, isBound, rebind) => {
  bind(VaultLocation).toConstantValue(async () => ({ files: new MemFilesApi(), dir: "/", persistent: false }));
  bind(VaultService).toSelf().inSingletonScope();
  const keyStore = ({ container }: interfaces.Context) =>
    new VaultKeyStore(() => container.get<VaultService>(VaultService).current);
  if (isBound(KeyStoreService)) rebind(KeyStoreService).toDynamicValue(keyStore).inSingletonScope();
  else bind(KeyStoreService).toDynamicValue(keyStore).inSingletonScope();
  bind(VaultUi).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(VaultUi);
  bind(CommandContribution).toService(VaultUi);
});
```
`src/browser/style/vault.css`:
```css
.vault-dialog .dialogContent {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 320px;
}

.vault-dialog .vault-message {
  color: var(--theia-errorForeground);
  margin: 0;
}
```

Also add `@theia-shell/theia-secret-vault` to `app/package.json` `dependencies` and to both build script filter lists.

- [ ] **Step 6: Build and smoke-check in the app**

Run: `pnpm install && pnpm --filter @theia-shell/app build && pnpm --filter @theia-shell/app test:e2e`
Expected: build clean; the existing 18 e2e tests still pass (the default `VaultLocation` is an in-memory session vault, so no dialog appears).

- [ ] **Step 7: README and commit**

`packages/theia-secret-vault/README.md`: what it is; the two files and their formats (copy the spec's JSON shapes); the unlock flow; the commands; the same-origin limit (copy the spec's *Risks* bullet); `VaultLocation` as the one binding an app sets; *Red / green*.
```bash
git add packages/theia-secret-vault app/package.json pnpm-lock.yaml
git commit -m "theia-shell: the vault behind Theia's KeyStoreService, with its dialog and commands

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Mount core — keys, configs, layers, `MountTable`

**Files:**
- Create: `packages/theia-files-mounts/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/theia-files-mounts/src/common/mount-keys.ts`
- Create: `packages/theia-files-mounts/src/common/mount-types.ts`
- Create: `packages/theia-files-mounts/src/common/mount-config.ts`
- Create: `packages/theia-files-mounts/src/common/mounted-files-api.ts`
- Create: `packages/theia-files-mounts/src/common/layers.ts`
- Create: `packages/theia-files-mounts/src/common/mount-table.ts`
- Create: `packages/theia-files-mounts/src/common/index.ts`
- Test: `packages/theia-files-mounts/tests/mount-keys.test.ts`, `mount-config.test.ts`, `layers.test.ts`, `mount-table.test.ts`

**Interfaces:**
- Consumes: `FilesApiChange` from `@theia-shell/theia-files-api`.
- Produces (from `@theia-shell/theia-files-mounts`):
  - `slugify(name): string`, `suggestKey(name, taken: Iterable<string>): string`, `validateKey(key, taken: Iterable<string>): string | undefined`
  - `interface MountField { name: string; label: string; kind: "text" | "secret" | "url"; required?: boolean; default?: string | ((mount: { key: string; name: string }) => string) }`
  - `interface MountConfig { key: string; name: string; type: string; config: Record<string, string> }`
  - `interface MountContext { interactive: boolean; locked: boolean; secret(field: string): Promise<string | undefined> }`
  - `interface MountType { id; label; fields: MountField[]; isAvailable(): boolean; create(mount, ctx): Promise<FilesApi>; configure?(mount): Promise<Record<string, string> | undefined>; forget?(mount): Promise<void> }`, `const MountType: symbol`
  - `class NeedsUserGesture extends Error`, `class SecretsLocked extends Error`
  - `type MountStatus = { state: "mounted" } | { state: "needs-access" } | { state: "locked" } | { state: "failed"; message: string }`
  - `validateMountConfigs(raw: unknown, types: ReadonlyMap<string, MountType>, reserved: readonly string[]): { valid: MountConfig[]; errors: string[] }`
  - `class MountedFilesApi(target: FilesApi)` with `setTarget(target)`
  - `interface FilesApiLayer { id; priority; wrap(root: FilesApi): FilesApi; onDidChange?: Event<void> }`, `const FilesApiLayer: symbol`, `applyLayers(root, layers): FilesApi`, `hiddenPathsFilter(globs: readonly string[]): (api: FilesApi) => FilesApi`, `systemFolderFilter(path: string | undefined): (api: FilesApi) => FilesApi`
  - `class MountTable(types: (id: string) => MountType | undefined, secrets: (mount: MountConfig, field: string) => Promise<string | undefined>, isLocked?: () => boolean)` with
    `apply(configs, options?: { fixed?: readonly { config: MountConfig; api: FilesApi }[]; interactive?: boolean; recreate?: (key: string, status: MountStatus) => boolean }): Promise<FilesApiChange[]>`,
    `composite(): FilesApi`, `status(key): MountStatus | undefined`, `configs(): MountConfig[]`

- [ ] **Step 1: Package skeleton**

`packages/theia-files-mounts/package.json`:
```json
{
  "name": "@theia-shell/theia-files-mounts",
  "version": "0.0.0",
  "private": true,
  "description": "Theia extension: a composite, filterable FilesApi of user-defined mount points over a main storage.",
  "main": "lib/common/index.js",
  "types": "lib/common/index.d.ts",
  "files": ["lib", "src"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@statewalker/webrun-files": "0.10.0",
    "@statewalker/webrun-files-browser": "0.10.0",
    "@statewalker/webrun-files-composite": "0.10.0",
    "@statewalker/webrun-files-mem": "0.10.0",
    "@theia-shell/theia-files-api": "workspace:*",
    "@theia-shell/theia-secret-vault": "workspace:*",
    "@theia/core": "1.76.0",
    "@theia/filesystem": "1.76.0",
    "@theia/navigator": "1.76.0",
    "@theia/userstorage": "1.76.0"
  }
}
```
`tsconfig.json`, `vitest.config.ts`: as in Task 3. `theiaExtensions` are added in Task 8.

- [ ] **Step 2: Write the failing tests**

`tests/mount-keys.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { slugify, suggestKey, validateKey } from "../src/common/mount-keys";

describe("mount keys", () => {
  it("derives a key from the name", () => {
    expect(slugify("Local Computer")).toBe("local-computer");
    expect(slugify("  My  S3 / Bucket!! ")).toBe("my-s3-bucket");
    expect(slugify("Мой диск")).toBe("mount");
    expect(slugify("東京")).toBe("mount");
  });

  it("suggests a free key", () => {
    expect(suggestKey("Cloud", [])).toBe("cloud");
    expect(suggestKey("Cloud", ["cloud", "cloud-2"])).toBe("cloud-3");
    expect(suggestKey("東京", ["mount"])).toBe("mount-2");
  });

  it("refuses empty, dot, slash and taken keys", () => {
    expect(validateKey("", [])).toMatch(/required/);
    expect(validateKey(".", [])).toBeDefined();
    expect(validateKey("..", [])).toBeDefined();
    expect(validateKey("a/b", [])).toMatch(/\//);
    expect(validateKey("cloud", ["cloud"])).toMatch(/already used/);
    expect(validateKey(".theia", [])).toBeUndefined();
    expect(validateKey("my-disk", ["cloud"])).toBeUndefined();
  });
});
```

`tests/mount-config.test.ts`:
```ts
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { validateMountConfigs } from "../src/common/mount-config";
import type { MountType } from "../src/common/mount-types";

const s3: MountType = {
  id: "s3",
  label: "S3",
  fields: [
    { name: "endpoint", label: "Endpoint", kind: "url", required: true },
    { name: "secretAccessKey", label: "Secret", kind: "secret", required: true },
  ],
  isAvailable: () => true,
  create: async () => new MemFilesApi(),
};
const types = new Map([["s3", s3]]);

describe("validateMountConfigs", () => {
  it("accepts valid entries", () => {
    const raw = [{ key: "cloud", name: "Cloud", type: "s3", config: { endpoint: "http://x" } }];
    expect(validateMountConfigs(raw, types, [])).toEqual({ valid: raw, errors: [] });
  });

  it("refuses a value that is not an array", () => {
    const result = validateMountConfigs({ key: "x" }, types, []);
    expect(result.valid).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it("skips each bad entry with one error and keeps the rest", () => {
    const good = { key: "ok", name: "OK", type: "s3", config: { endpoint: "http://x" } };
    const result = validateMountConfigs(
      [
        { name: "No key", type: "s3", config: {} },
        { key: "a", name: "A", type: "ftp", config: {} },
        { key: "b", name: "B", type: "s3", config: {} },
        { key: "c", name: "C", type: "s3", config: { endpoint: "http://x", secretAccessKey: "oops" } },
        good,
        { ...good, name: "Duplicate" },
        { key: "browser", name: "Clash", type: "s3", config: { endpoint: "http://x" } },
        "not an object",
      ],
      types,
      ["browser"],
    );
    expect(result.valid).toEqual([good]);
    expect(result.errors).toHaveLength(7);
    expect(result.errors.join("\n")).toMatch(/secret/i);
  });
});
```

`tests/layers.test.ts`:
```ts
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { applyLayers, type FilesApiLayer, hiddenPathsFilter, systemFolderFilter } from "../src/common/layers";

async function names(api: MemFilesApi | ReturnType<typeof applyLayers>, path: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of api.list(path)) found.push(entry.name);
  return found.sort();
}

describe("layers", () => {
  it("wraps in priority order, lowest closest to the root", () => {
    const order: string[] = [];
    const layer = (id: string, priority: number): FilesApiLayer => ({
      id,
      priority,
      wrap: (api) => {
        order.push(id);
        return api;
      },
    });
    applyLayers(new MemFilesApi(), [layer("outer", 10), layer("inner", 0)]);
    expect(order).toEqual(["inner", "outer"]);
  });

  it("hides globbed paths from listing, stats and reads, and refuses writes", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/m/.git/HEAD", "ref");
    await writeText(files, "/m/a.log", "log");
    await writeText(files, "/m/a.md", "# a");
    const view = hiddenPathsFilter(["**/.git", "**/.git/**", "**/*.log"])(files);
    expect(await names(view, "/m")).toEqual(["a.md"]);
    expect(await view.stats("/m/.git/HEAD")).toBeUndefined();
    await expect(writeText(view, "/m/b.log", "x")).rejects.toThrow();
    expect(hiddenPathsFilter([])(files)).toBe(files);
  });

  it("hides the main storage's system folder", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/browser/.shell/settings/settings.json", "{}");
    await writeText(files, "/browser/notes.md", "");
    const view = systemFolderFilter("/browser/.shell")(files);
    expect(await names(view, "/browser")).toEqual(["notes.md"]);
    expect(systemFolderFilter(undefined)(files)).toBe(files);
  });
});
```

`tests/mount-table.test.ts`:
```ts
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { MountTable } from "../src/common/mount-table";
import { type MountConfig, type MountType, NeedsUserGesture, SecretsLocked } from "../src/common/mount-types";

function fakeTypes() {
  const created: string[] = [];
  const failing = new Set<string>();
  const gesture = new Set<string>();
  const type: MountType = {
    id: "mem",
    label: "Memory",
    fields: [],
    isAvailable: () => true,
    create: async (mount, ctx) => {
      created.push(mount.key);
      if (failing.has(mount.key)) throw new Error("boom");
      if (gesture.has(mount.key) && !ctx.interactive) throw new NeedsUserGesture();
      if (mount.config.needsSecret && !(await ctx.secret("token"))) {
        throw ctx.locked ? new SecretsLocked() : new Error("missing token");
      }
      return new MemFilesApi();
    },
  };
  return { type, created, failing, gesture };
}

const mount = (key: string, config: Record<string, string> = {}): MountConfig => ({ key, name: key.toUpperCase(), type: "mem", config });

async function rootNames(table: MountTable): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of table.composite().list("/")) found.push(entry.name);
  return found.sort();
}

describe("MountTable", () => {
  it("lists every mount, fixed ones included, as a root folder", async () => {
    const { type } = fakeTypes();
    const table = new MountTable(() => type, async () => undefined);
    const main = new MemFilesApi();
    await table.apply([mount("a"), mount("b")], { fixed: [{ config: { key: "browser", name: "Browser", type: "main", config: {} }, api: main }] });
    expect(await rootNames(table)).toEqual(["a", "b", "browser"]);
    await writeText(table.composite(), "/browser/x.md", "hi");
    expect(await readText(main, "/x.md")).toBe("hi");
  });

  it("mounts a failing type as a placeholder and keeps the others", async () => {
    const t = fakeTypes();
    t.failing.add("bad");
    const table = new MountTable(() => t.type, async () => undefined);
    await table.apply([mount("bad"), mount("good")]);
    expect(table.status("bad")).toEqual({ state: "failed", message: "boom" });
    expect(table.status("good")).toEqual({ state: "mounted" });
    expect(await rootNames(table)).toEqual(["bad", "good"]);
    await expect(writeText(table.composite(), "/bad/x", "")).rejects.toThrow();
  });

  it("reports needs-access and locked, and recreates them on request", async () => {
    const t = fakeTypes();
    t.gesture.add("folder");
    let token: string | undefined;
    let locked = true;
    const table = new MountTable(() => t.type, async () => token, () => locked);
    const configs = [mount("folder"), mount("cloud", { needsSecret: "yes" })];
    await table.apply(configs);
    expect(table.status("folder")).toEqual({ state: "needs-access" });
    expect(table.status("cloud")).toEqual({ state: "locked" });
    token = "t";
    locked = false;
    await table.apply(configs, { recreate: (_key, status) => status.state === "locked" });
    expect(table.status("cloud")).toEqual({ state: "mounted" });
    expect(table.status("folder")).toEqual({ state: "needs-access" });
    await table.apply(configs, { interactive: true, recreate: (key) => key === "folder" });
    expect(table.status("folder")).toEqual({ state: "mounted" });
  });

  it("calls a missing secret 'failed', not 'locked', while the vault is unlocked", async () => {
    const t = fakeTypes();
    const table = new MountTable(() => t.type, async () => undefined, () => false);
    await table.apply([mount("cloud", { needsSecret: "yes" })]);
    expect(table.status("cloud")).toEqual({ state: "failed", message: "missing token" });
  });

  it("re-creates only what changed and reports it", async () => {
    const t = fakeTypes();
    const table = new MountTable(() => t.type, async () => undefined);
    expect(await table.apply([mount("a"), mount("b")])).toEqual(
      expect.arrayContaining([
        { type: "added", path: "/a" },
        { type: "added", path: "/b" },
      ]),
    );
    t.created.length = 0;
    const changes = await table.apply([mount("a"), mount("b", { flavour: "new" })]);
    expect(t.created).toEqual(["b"]);
    expect(changes).toEqual([{ type: "updated", path: "/b" }]);
  });

  it("treats a key change with the same type and config as a rename: same files", async () => {
    const t = fakeTypes();
    const table = new MountTable(() => t.type, async () => undefined);
    await table.apply([mount("old")]);
    await writeText(table.composite(), "/old/keep.md", "kept");
    t.created.length = 0;
    const changes = await table.apply([{ ...mount("new"), name: "Renamed" }]);
    expect(t.created).toEqual([]);
    expect(await readText(table.composite(), "/new/keep.md")).toBe("kept");
    expect(changes).toEqual(
      expect.arrayContaining([
        { type: "deleted", path: "/old" },
        { type: "added", path: "/new" },
      ]),
    );
    expect(table.configs().map((c) => c.name)).toEqual(["Renamed"]);
  });

  it("unmounts what is no longer configured", async () => {
    const t = fakeTypes();
    const table = new MountTable(() => t.type, async () => undefined);
    await table.apply([mount("a"), mount("b")]);
    expect(await table.apply([mount("a")])).toEqual([{ type: "deleted", path: "/b" }]);
    expect(await rootNames(table)).toEqual(["a"]);
    expect(table.status("b")).toBeUndefined();
  });

  it("fails an unknown type without throwing", async () => {
    const table = new MountTable(() => undefined, async () => undefined);
    await table.apply([mount("x")]);
    expect(table.status("x")).toEqual({ state: "failed", message: 'Unknown mount type "mem"' });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm install && pnpm --filter @theia-shell/theia-files-mounts test`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`src/common/mount-keys.ts`:
```ts
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
```

`src/common/mount-types.ts`:
```ts
import type { FilesApi } from "@statewalker/webrun-files";

export interface MountField {
  name: string;
  label: string;
  kind: "text" | "secret" | "url";
  required?: boolean;
  default?: string | ((mount: { key: string; name: string }) => string);
}

/** One entry of the `files.mounts` preference. `config` never holds secrets. */
export interface MountConfig {
  key: string;
  name: string;
  type: string;
  config: Record<string, string>;
}

export interface MountContext {
  /** True when running from a user gesture (wizard, Reconnect). */
  interactive: boolean;
  /** True while the vault is locked: a missing secret then means "locked", not "missing". */
  locked: boolean;
  /** A `secret` field's value from the vault; undefined when locked or absent. */
  secret(field: string): Promise<string | undefined>;
}

/** A kind of file system users can mount. Bind with `bind(MountType).to…`. */
export const MountType = Symbol("MountType");
export interface MountType {
  readonly id: string;
  readonly label: string;
  readonly fields: MountField[];
  isAvailable(): boolean;
  create(mount: MountConfig, ctx: MountContext): Promise<FilesApi>;
  /** An interactive step after the fields (e.g. a folder picker); returns config to merge, or undefined to cancel. */
  configure?(mount: MountConfig): Promise<Record<string, string> | undefined>;
  /** Cleans up what the type stored outside `config` when the mount is removed. */
  forget?(mount: MountConfig): Promise<void>;
}

/** Thrown by `create` when it can only proceed from a user gesture. */
export class NeedsUserGesture extends Error {
  constructor() {
    super("Needs a click to get access");
    this.name = "NeedsUserGesture";
  }
}

/** Thrown by `create` when a required secret is unavailable because the vault is locked (`ctx.locked`). */
export class SecretsLocked extends Error {
  constructor() {
    super("Secrets are locked");
    this.name = "SecretsLocked";
  }
}

export type MountStatus =
  | { state: "mounted" }
  | { state: "needs-access" }
  | { state: "locked" }
  | { state: "failed"; message: string };
```

`src/common/mount-config.ts`:
```ts
import { validateKey } from "./mount-keys";
import type { MountConfig, MountType } from "./mount-types";

/**
 * Checks a `files.mounts` value as a user may have typed it. Every bad entry
 * is skipped with one error; the valid ones are returned in order.
 */
export function validateMountConfigs(
  raw: unknown,
  types: ReadonlyMap<string, MountType>,
  reserved: readonly string[],
): { valid: MountConfig[]; errors: string[] } {
  if (!Array.isArray(raw)) return { valid: [], errors: ["files.mounts must be an array of mounts."] };
  const valid: MountConfig[] = [];
  const errors: string[] = [];
  const taken = [...reserved];
  raw.forEach((entry, index) => {
    const error = checkEntry(entry, types, taken);
    if (error) {
      errors.push(`files.mounts[${index}]: ${error}`);
      return;
    }
    const mount = entry as MountConfig;
    taken.push(mount.key);
    valid.push(mount);
  });
  return { valid, errors };
}

function checkEntry(entry: unknown, types: ReadonlyMap<string, MountType>, taken: string[]): string | undefined {
  if (typeof entry !== "object" || entry === null) return "not an object.";
  const { key, name, type, config } = entry as Partial<MountConfig>;
  if (typeof key !== "string") return "missing key.";
  const keyError = validateKey(key, taken);
  if (keyError) return keyError;
  if (typeof name !== "string" || !name.trim()) return `mount "${key}" has no name.`;
  const mountType = typeof type === "string" ? types.get(type) : undefined;
  if (!mountType) return `mount "${key}" has an unknown type "${String(type)}".`;
  if (typeof config !== "object" || config === null) return `mount "${key}" has no config.`;
  for (const field of mountType.fields) {
    const value = (config as Record<string, unknown>)[field.name];
    if (field.kind === "secret") {
      if (value !== undefined) return `mount "${key}": the secret "${field.name}" belongs in the vault, not in settings.`;
    } else if (field.required && (typeof value !== "string" || !value)) {
      return `mount "${key}" is missing "${field.name}".`;
    }
  }
  return undefined;
}
```

`src/common/mounted-files-api.ts`:
```ts
import type { FileInfo, FileStats, FilesApi, ListOptions, ReadOptions } from "@statewalker/webrun-files";

/** A stable FilesApi whose target can be swapped (the mount pipeline is rebuilt behind it). */
export class MountedFilesApi implements FilesApi {
  constructor(protected target: FilesApi) {}

  setTarget(target: FilesApi): void {
    this.target = target;
  }

  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    return this.target.read(path, options);
  }
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void> {
    return this.target.write(path, content);
  }
  mkdir(path: string): Promise<void> {
    return this.target.mkdir(path);
  }
  list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    return this.target.list(path, options);
  }
  stats(path: string): Promise<FileStats | undefined> {
    return this.target.stats(path);
  }
  exists(path: string): Promise<boolean> {
    return this.target.exists(path);
  }
  remove(path: string): Promise<boolean> {
    return this.target.remove(path);
  }
  move(source: string, target: string): Promise<boolean> {
    return this.target.move(source, target);
  }
  copy(source: string, target: string): Promise<boolean> {
    return this.target.copy(source, target);
  }
}
```

`src/common/layers.ts`:
```ts
import type { FilesApi } from "@statewalker/webrun-files";
import { FilteredFilesApi, newGlobPathFilter, newPathFilter } from "@statewalker/webrun-files-composite";
import type { Event } from "@theia/core/lib/common/event";

/** A wrapper around the mount composite. Bind with `bind(FilesApiLayer).to…`. */
export const FilesApiLayer = Symbol("FilesApiLayer");
export interface FilesApiLayer {
  readonly id: string;
  /** Lower wraps first (closer to the composite). */
  readonly priority: number;
  wrap(root: FilesApi): FilesApi;
  /** Fires when `wrap` would now wrap differently. */
  readonly onDidChange?: Event<void>;
}

export function applyLayers(root: FilesApi, layers: readonly FilesApiLayer[]): FilesApi {
  return [...layers].sort((a, b) => a.priority - b.priority).reduce((api, layer) => layer.wrap(api), root);
}

/** Hides every path matching one of `globs`; no globs → the api itself. */
export function hiddenPathsFilter(globs: readonly string[]): (api: FilesApi) => FilesApi {
  return (api) => (globs.length ? new FilteredFilesApi(api, newGlobPathFilter(...globs)) : api);
}

/** Hides one folder and everything in it; no path → the api itself. */
export function systemFolderFilter(path: string | undefined): (api: FilesApi) => FilesApi {
  return (api) => (path ? new FilteredFilesApi(api, newPathFilter(path)) : api);
}
```

`src/common/mount-table.ts`:
```ts
import type { FilesApi } from "@statewalker/webrun-files";
import { CompositeFilesApi, readOnly } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { FilesApiChange } from "@theia-shell/theia-files-api";
import { type MountConfig, type MountStatus, type MountType, NeedsUserGesture, SecretsLocked } from "./mount-types";

interface Entry {
  config: MountConfig;
  api: FilesApi;
  status: MountStatus;
}

export interface ApplyOptions {
  /** Mounts supplied ready-made (the main storage); always present. */
  fixed?: readonly { config: MountConfig; api: FilesApi }[];
  /** Passed to the types' `create` for mounts (re)created in this call. */
  interactive?: boolean;
  /** Re-create an unchanged mount anyway (e.g. `locked` after an unlock). */
  recreate?: (key: string, status: MountStatus) => boolean;
}

const empty = () => readOnly(new MemFilesApi());

/**
 * The set of mounted file systems and the composite that shows them as root
 * folders. `apply` brings it to a new list of configs: unchanged mounts are
 * kept, a key change with the same type and config is a rename (the same
 * FilesApi), anything else is (re)created. A mount that cannot be created is
 * an empty read-only placeholder with a status saying why.
 */
export class MountTable {
  protected entries = new Map<string, Entry>();
  protected root: FilesApi = new CompositeFilesApi(empty());

  constructor(
    protected readonly types: (id: string) => MountType | undefined,
    protected readonly secrets: (mount: MountConfig, field: string) => Promise<string | undefined>,
    protected readonly isLocked: () => boolean = () => false,
  ) {}

  composite(): FilesApi {
    return this.root;
  }

  status(key: string): MountStatus | undefined {
    return this.entries.get(key)?.status;
  }

  configs(): MountConfig[] {
    return [...this.entries.values()].map((e) => e.config);
  }

  async apply(configs: readonly MountConfig[], options: ApplyOptions = {}): Promise<FilesApiChange[]> {
    const previous = this.entries;
    const next = new Map<string, Entry>();
    const claimed = new Set<Entry>();
    const newKeys = new Set([...configs.map((c) => c.key), ...(options.fixed ?? []).map((f) => f.config.key)]);

    for (const { config, api } of options.fixed ?? []) {
      const entry = { config, api, status: { state: "mounted" } as MountStatus };
      next.set(config.key, entry);
    }
    await Promise.all(
      configs.map(async (config) => {
        const same = previous.get(config.key);
        if (same && sameMount(same.config, config) && !options.recreate?.(config.key, same.status)) {
          claimed.add(same);
          next.set(config.key, { ...same, config });
          return;
        }
        const renamed = [...previous.values()].find(
          (e) => !claimed.has(e) && !newKeys.has(e.config.key) && sameMount(e.config, config) && e.status.state === "mounted",
        );
        if (renamed) {
          claimed.add(renamed);
          next.set(config.key, { ...renamed, config });
          return;
        }
        next.set(config.key, await this.create(config, options.interactive ?? false));
      }),
    );

    const changes: FilesApiChange[] = [];
    for (const key of previous.keys()) if (!next.has(key)) changes.push({ type: "deleted", path: `/${key}` });
    for (const [key, entry] of next) {
      const before = previous.get(key);
      if (!before) changes.push({ type: "added", path: `/${key}` });
      else if (before.api !== entry.api || before.status.state !== entry.status.state) {
        changes.push({ type: "updated", path: `/${key}` });
      }
    }

    // Keep the caller's order for configs; fixed mounts first.
    const ordered = new Map<string, Entry>();
    for (const { config } of options.fixed ?? []) ordered.set(config.key, next.get(config.key) as Entry);
    for (const config of configs) ordered.set(config.key, next.get(config.key) as Entry);
    this.entries = ordered;
    const composite = new CompositeFilesApi(empty());
    for (const [key, entry] of ordered) composite.mount(`/${key}`, entry.api);
    this.root = composite;
    return changes;
  }

  protected async create(config: MountConfig, interactive: boolean): Promise<Entry> {
    const type = this.types(config.type);
    if (!type) return { config, api: empty(), status: { state: "failed", message: `Unknown mount type "${config.type}"` } };
    try {
      const api = await type.create(config, {
        interactive,
        locked: this.isLocked(),
        secret: (field) => this.secrets(config, field),
      });
      return { config, api, status: { state: "mounted" } };
    } catch (error) {
      const status: MountStatus =
        error instanceof NeedsUserGesture
          ? { state: "needs-access" }
          : error instanceof SecretsLocked
            ? { state: "locked" }
            : { state: "failed", message: error instanceof Error ? error.message : String(error) };
      return { config, api: empty(), status };
    }
  }
}

function sameMount(a: MountConfig, b: MountConfig): boolean {
  return a.type === b.type && canonical(a.config) === canonical(b.config);
}

function canonical(config: Record<string, string>): string {
  return JSON.stringify(Object.keys(config).sort().map((k) => [k, config[k]]));
}
```

`src/common/index.ts`:
```ts
export * from "./layers";
export * from "./mount-config";
export * from "./mount-keys";
export * from "./mount-table";
export * from "./mount-types";
export * from "./mounted-files-api";
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @theia-shell/theia-files-mounts test && pnpm --filter @theia-shell/theia-files-mounts build`
Expected: 17 passed; build clean. If the `**/.git` glob does not hide `/m/.git` itself, the fix is in the glob list (both `**/.git` and `**/.git/**` are given), not in `hiddenPathsFilter`.

- [ ] **Step 6: Commit**

```bash
git add packages/theia-files-mounts pnpm-lock.yaml
git commit -m "theia-shell: mount core — keys, config checks, layers and the mount table

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Built-in mount types — memory, OPFS, local folder

**Files:**
- Create: `packages/theia-files-mounts/src/common/folder-access.ts`
- Create: `packages/theia-files-mounts/src/browser/mount-types/memory-mount-type.ts`
- Create: `packages/theia-files-mounts/src/browser/mount-types/opfs-mount-type.ts`
- Create: `packages/theia-files-mounts/src/browser/mount-types/local-folder-mount-type.ts`
- Test: `packages/theia-files-mounts/tests/folder-access.test.ts`

**Interfaces:**
- Consumes: `MountType`, `NeedsUserGesture` (Task 5); `IdbStore` (Task 4).
- Produces:
  - `ensureFolderAccess(handle: PermissionHandle, interactive: boolean, accessible: () => Promise<boolean>): Promise<void>`, `interface PermissionHandle`
  - Injectable classes `MemoryMountType` (id `memory`), `OpfsMountType` (id `opfs`), `LocalFolderMountType` (id `local-folder`).
  - OPFS storage: `navigator.storage.getDirectory()` → `mounts/<config.directory>`.
  - Local-folder handles: `IdbStore<FileSystemDirectoryHandle>("theia-shell-handles")`, key = `config.handleId`.

- [ ] **Step 1: Write the failing test**

`tests/folder-access.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ensureFolderAccess, type PermissionHandle } from "../src/common/folder-access";
import { NeedsUserGesture } from "../src/common/mount-types";

function handle(query: PermissionState, request: PermissionState = query): PermissionHandle & { requested: number } {
  return {
    requested: 0,
    async queryPermission() {
      return query;
    },
    async requestPermission() {
      this.requested++;
      return request;
    },
  };
}
const yes = async () => true;

describe("ensureFolderAccess", () => {
  it("passes when access is already granted, without asking", async () => {
    const h = handle("granted");
    await ensureFolderAccess(h, false, yes);
    expect(h.requested).toBe(0);
  });

  it("needs a gesture at boot when the browser would prompt", async () => {
    await expect(ensureFolderAccess(handle("prompt"), false, yes)).rejects.toBeInstanceOf(NeedsUserGesture);
  });

  it("asks from a gesture, and passes when granted", async () => {
    const h = handle("prompt", "granted");
    await ensureFolderAccess(h, true, yes);
    expect(h.requested).toBe(1);
  });

  it("fails when the user denies it", async () => {
    await expect(ensureFolderAccess(handle("prompt", "denied"), true, yes)).rejects.toThrow(/not granted/);
  });

  it("fails when the folder is gone", async () => {
    await expect(ensureFolderAccess(handle("granted"), false, async () => false)).rejects.toThrow(/gone/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @theia-shell/theia-files-mounts exec vitest run tests/folder-access.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/common/folder-access.ts`:
```ts
import { NeedsUserGesture } from "./mount-types";

/** The File System Access permission methods (not yet in TypeScript's DOM lib). */
export interface PermissionHandle {
  queryPermission(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
}

/**
 * Read-write access to a stored folder handle. At boot (not interactive) the
 * browser may only be asked from a click, so a "prompt" means NeedsUserGesture.
 */
export async function ensureFolderAccess(
  handle: PermissionHandle,
  interactive: boolean,
  accessible: () => Promise<boolean>,
): Promise<void> {
  let permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted" && interactive) permission = await handle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    if (interactive) throw new Error("Access to the folder was not granted.");
    throw new NeedsUserGesture();
  }
  if (!(await accessible())) throw new Error("The folder is gone (moved or deleted).");
}
```

`src/browser/mount-types/memory-mount-type.ts`:
```ts
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { injectable } from "@theia/core/shared/inversify";
import type { MountField, MountType } from "../../common/mount-types";

@injectable()
export class MemoryMountType implements MountType {
  readonly id = "memory";
  readonly label = "In Memory (lost on reload)";
  readonly fields: MountField[] = [];

  isAvailable(): boolean {
    return true;
  }

  async create(): Promise<FilesApi> {
    return new MemFilesApi();
  }
}
```

`src/browser/mount-types/opfs-mount-type.ts`:
```ts
import type { FilesApi } from "@statewalker/webrun-files";
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { injectable } from "@theia/core/shared/inversify";
import type { MountConfig, MountField, MountType } from "../../common/mount-types";

/** A folder of the browser's Origin Private File System, under `mounts/`. */
@injectable()
export class OpfsMountType implements MountType {
  readonly id = "opfs";
  readonly label = "Browser Storage (OPFS)";
  readonly fields: MountField[] = [
    { name: "directory", label: "Folder name in browser storage", kind: "text", required: true, default: (m) => m.key },
  ];

  isAvailable(): boolean {
    return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
  }

  async create(mount: MountConfig): Promise<FilesApi> {
    const root = await navigator.storage.getDirectory();
    const mounts = await root.getDirectoryHandle("mounts", { create: true });
    const rootHandle = await mounts.getDirectoryHandle(mount.config.directory, { create: true });
    return new BrowserFilesApi({ rootHandle });
  }
}
```

`src/browser/mount-types/local-folder-mount-type.ts`:
```ts
import type { FilesApi } from "@statewalker/webrun-files";
import { BrowserFilesApi, isHandlerAccessible } from "@statewalker/webrun-files-browser";
import { injectable } from "@theia/core/shared/inversify";
import { IdbStore } from "@theia-shell/theia-secret-vault/lib/browser/idb-store";
import { ensureFolderAccess, type PermissionHandle } from "../../common/folder-access";
import type { MountConfig, MountContext, MountField, MountType } from "../../common/mount-types";

type Picker = (options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>;

/** A folder on the user's computer (File System Access API). The handle lives in IndexedDB. */
@injectable()
export class LocalFolderMountType implements MountType {
  readonly id = "local-folder";
  readonly label = "Folder on this Computer";
  readonly fields: MountField[] = [];
  protected readonly handles = new IdbStore<FileSystemDirectoryHandle>("theia-shell-handles");

  isAvailable(): boolean {
    return typeof window !== "undefined" && "showDirectoryPicker" in window;
  }

  async configure(): Promise<Record<string, string> | undefined> {
    const pick = (window as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker;
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await pick({ mode: "readwrite" });
    } catch {
      return undefined; // the user closed the picker
    }
    const handleId = crypto.randomUUID();
    await this.handles.set(handleId, handle);
    return { directory: handle.name, handleId };
  }

  async create(mount: MountConfig, ctx: MountContext): Promise<FilesApi> {
    const handle = await this.handles.get(mount.config.handleId);
    if (!handle) throw new Error("This browser no longer knows the folder; edit the mount to pick it again.");
    await ensureFolderAccess(handle as unknown as PermissionHandle, ctx.interactive, () => isHandlerAccessible(handle));
    return new BrowserFilesApi({ rootHandle: handle });
  }

  async forget(mount: MountConfig): Promise<void> {
    if (mount.config.handleId) await this.handles.delete(mount.config.handleId);
  }
}
```

- [ ] **Step 4: Run the tests and build**

Run: `pnpm --filter @theia-shell/theia-files-mounts test && pnpm --filter @theia-shell/theia-files-mounts build`
Expected: 22 passed; build clean. (OPFS and local folder are driven end to end in Task 9.)

- [ ] **Step 5: Commit**

```bash
git add packages/theia-files-mounts
git commit -m "theia-shell: memory, OPFS and local-folder mount types

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Main storage, the boot gate, and settings under `shell-system:`

**Files:**
- Create: `packages/theia-files-mounts/src/common/system-folder.ts`
- Create: `packages/theia-files-mounts/src/browser/main-storage.ts`
- Create: `packages/theia-files-mounts/src/browser/boot-gate.ts`
- Create: `packages/theia-files-mounts/src/browser/system-storage.ts`
- Create: `packages/theia-files-mounts/src/browser/style/boot-gate.css`
- Test: `packages/theia-files-mounts/tests/system-folder.test.ts`

**Interfaces:**
- Consumes: `IdbStore` (Task 4), `FilesApiFileSystemProvider` (theia-files-api).
- Produces:
  - `SYSTEM_FOLDER = "/.shell"`, `SETTINGS_FOLDER = "/.shell/settings"`, `ensureSystemFolder(files): Promise<void>`, `hasSystemFolder(files): Promise<boolean>`, `copySystemFolder(from, to): Promise<void>`
  - `type MainStorage = { type: "opfs" | "memory"; key: string; name: string } | { type: "local-folder"; key: string; name: string; handle: FileSystemDirectoryHandle }`, `DEFAULT_MAIN`
  - `interface OpenedMainStorage { storage: MainStorage; files: FilesApi; persistent: boolean }`
  - `MainStorageService` with `open(): Promise<OpenedMainStorage>`, `current: OpenedMainStorage | undefined`, `choose(next: MainStorage): Promise<void>`
  - DI `MainStorageInitializer` symbol (optional): `(opened: OpenedMainStorage) => Promise<void>`, run inside `open()` before it resolves (the app seeds its demo files there, so the explorer never lists an unseeded tree)
  - `bootGate(storage, handleAccessible): Promise<"opened" | "fallback">` — DOM class `boot-gate`, buttons `.boot-gate-open`, `.boot-gate-fallback`
  - `SHELL_SYSTEM_SCHEME = "shell-system"`, `ShellSystemFileServiceContribution`, `ShellUserStorageContribution`, `shellEnvVariablesServer`

- [ ] **Step 1: Write the failing test**

`tests/system-folder.test.ts`:
```ts
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { copySystemFolder, ensureSystemFolder, hasSystemFolder } from "../src/common/system-folder";

describe("system folder", () => {
  it("is created with its settings folder", async () => {
    const files = new MemFilesApi();
    expect(await hasSystemFolder(files)).toBe(false);
    await ensureSystemFolder(files);
    expect(await hasSystemFolder(files)).toBe(true);
    expect((await files.stats("/.shell/settings"))?.kind).toBe("directory");
    await ensureSystemFolder(files); // idempotent
  });

  it("is copied whole to another storage, user files untouched", async () => {
    const from = new MemFilesApi();
    await writeText(from, "/.shell/settings/settings.json", '{"files.hidden":[]}');
    await writeText(from, "/.shell/vault.key.json", "{}");
    await writeText(from, "/.shell/secrets.json", "{}");
    await writeText(from, "/notes.md", "user file");
    const to = new MemFilesApi();
    await writeText(to, "/mine.md", "theirs");
    await copySystemFolder(from, to);
    expect(await readText(to, "/.shell/settings/settings.json")).toBe('{"files.hidden":[]}');
    expect(await readText(to, "/.shell/vault.key.json")).toBe("{}");
    expect(await to.exists("/notes.md")).toBe(false);
    expect(await readText(to, "/mine.md")).toBe("theirs");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @theia-shell/theia-files-mounts exec vitest run tests/system-folder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure part**

`src/common/system-folder.ts`:
```ts
import type { FilesApi } from "@statewalker/webrun-files";

/** In the main storage: settings, vault key and secrets. Never shown in the file tree. */
export const SYSTEM_FOLDER = "/.shell";
export const SETTINGS_FOLDER = "/.shell/settings";

export async function hasSystemFolder(files: FilesApi): Promise<boolean> {
  return (await files.stats(SYSTEM_FOLDER))?.kind === "directory";
}

export async function ensureSystemFolder(files: FilesApi): Promise<void> {
  for (const path of [SYSTEM_FOLDER, SETTINGS_FOLDER]) {
    if (!(await files.exists(path))) await files.mkdir(path);
  }
}

/** Copies the system folder (settings, vault) to another storage; the password stays the same. */
export async function copySystemFolder(from: FilesApi, to: FilesApi): Promise<void> {
  await ensureSystemFolder(to);
  for await (const entry of from.list(SYSTEM_FOLDER, { recursive: true })) {
    if (entry.kind === "directory") {
      if (!(await to.exists(entry.path))) await to.mkdir(entry.path);
    } else {
      await to.write(entry.path, from.read(entry.path));
    }
  }
}
```
(Check `FileInfo.path` is the full path in 0.10.0 by reading `node_modules/@statewalker/webrun-files/dist/types.d.ts`; if it is relative, join it with `SYSTEM_FOLDER`.)

- [ ] **Step 4: Run it**

Run: `pnpm --filter @theia-shell/theia-files-mounts exec vitest run tests/system-folder.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Implement the browser part**

`src/browser/boot-gate.ts`:
```ts
import "./style/boot-gate.css";

/**
 * Shown before the workbench when the main storage is a local folder whose
 * access must be re-granted by a click (a browser rule). Plain DOM: Theia's
 * UI cannot start before the settings it would read from that folder.
 */
export function bootGate(
  name: string,
  requestAccess: () => Promise<boolean>,
  accessible: () => Promise<boolean>,
): Promise<"opened" | "fallback"> {
  return new Promise((resolve) => {
    const gate = document.createElement("div");
    gate.className = "boot-gate";
    const text = document.createElement("p");
    text.textContent = `Theia Shell keeps its files and settings in the folder “${name}”. Open it to continue.`;
    const open = document.createElement("button");
    open.className = "boot-gate-open";
    open.textContent = `Open “${name}”`;
    const fallback = document.createElement("button");
    fallback.className = "boot-gate-fallback";
    fallback.textContent = "Use Browser Storage this time";
    const done = (result: "opened" | "fallback") => {
      gate.remove();
      resolve(result);
    };
    open.onclick = async () => {
      if (!(await requestAccess())) {
        text.textContent = `Access to “${name}” was not granted.`;
        return;
      }
      if (!(await accessible())) {
        text.textContent = `The folder “${name}” is gone (moved or deleted).`;
        open.remove();
        return;
      }
      done("opened");
    };
    fallback.onclick = () => done("fallback");
    gate.append(text, open, fallback);
    document.body.appendChild(gate);
  });
}
```

`src/browser/style/boot-gate.css`:
```css
.boot-gate {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--theia-editor-background, #1e1e1e);
  color: var(--theia-foreground, #ccc);
  font-family: sans-serif;
}
```

`src/browser/main-storage.ts`:
```ts
import type { FilesApi } from "@statewalker/webrun-files";
import { BrowserFilesApi, isHandlerAccessible } from "@statewalker/webrun-files-browser";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { inject, injectable, optional } from "@theia/core/shared/inversify";
import { IdbStore } from "@theia-shell/theia-secret-vault/lib/browser/idb-store";
import type { PermissionHandle } from "../common/folder-access";
import { ensureSystemFolder } from "../common/system-folder";
import { bootGate } from "./boot-gate";

export type MainStorage =
  | { type: "opfs" | "memory"; key: string; name: string }
  | { type: "local-folder"; key: string; name: string; handle: FileSystemDirectoryHandle };

export const DEFAULT_MAIN: MainStorage = { type: "opfs", key: "browser", name: "Browser Storage" };

export interface OpenedMainStorage {
  storage: MainStorage;
  files: FilesApi;
  persistent: boolean;
}

/** Optional: runs once the main storage is open, before anything reads it (the app seeds it). */
export const MainStorageInitializer = Symbol("MainStorageInitializer");
export type MainStorageInitializer = (opened: OpenedMainStorage) => Promise<void>;

/**
 * The one persistent mount holding `/.shell` (settings, vault). Which storage
 * is main is kept in IndexedDB, because the settings are read from it.
 * `?storage=memory`, or no OPFS: an in-memory main, not persistent.
 */
@injectable()
export class MainStorageService {
  @inject(MainStorageInitializer) @optional() protected readonly initializer?: MainStorageInitializer;
  protected readonly store = new IdbStore<MainStorage>("theia-shell-boot");
  protected opened: Promise<OpenedMainStorage> | undefined;
  current: OpenedMainStorage | undefined;

  open(): Promise<OpenedMainStorage> {
    this.opened ??= this.doOpen().then(async (opened) => {
      await ensureSystemFolder(opened.files);
      await this.initializer?.(opened);
      this.current = opened;
      return opened;
    });
    return this.opened;
  }

  async choose(next: MainStorage): Promise<void> {
    await this.store.set("main", next);
  }

  protected async doOpen(): Promise<OpenedMainStorage> {
    const memory = new URLSearchParams(location.search).get("storage") === "memory";
    if (memory || !navigator.storage?.getDirectory) {
      return { storage: { ...DEFAULT_MAIN, type: "memory" }, files: new MemFilesApi(), persistent: false };
    }
    const saved = (await this.store.get("main")) ?? DEFAULT_MAIN;
    if (saved.type === "local-folder") {
      const handle = saved.handle as unknown as PermissionHandle;
      const granted = (await handle.queryPermission({ mode: "readwrite" })) === "granted";
      const result =
        granted && (await isHandlerAccessible(saved.handle))
          ? "opened"
          : await bootGate(
              saved.name,
              async () => (await handle.requestPermission({ mode: "readwrite" })) === "granted",
              () => isHandlerAccessible(saved.handle),
            );
      if (result === "opened") return { storage: saved, files: new BrowserFilesApi({ rootHandle: saved.handle }), persistent: true };
      return this.openOpfs(DEFAULT_MAIN);
    }
    return this.openOpfs(saved);
  }

  protected async openOpfs(storage: MainStorage): Promise<OpenedMainStorage> {
    const root = await navigator.storage.getDirectory();
    const rootHandle = await root.getDirectoryHandle("main", { create: true });
    return { storage, files: new BrowserFilesApi({ rootHandle }), persistent: true };
  }
}
```

`src/browser/system-storage.ts`:
```ts
import { CompositeFilesApi } from "@statewalker/webrun-files-composite";
import type { EnvVariablesServer } from "@theia/core/lib/common/env-variables";
import { inject, injectable } from "@theia/core/shared/inversify";
import type { FileService, FileServiceContribution } from "@theia/filesystem/lib/browser/file-service";
import { FilesApiFileSystemProvider } from "@theia-shell/theia-files-api";
import { UserStorageContribution } from "@theia/userstorage/lib/browser/user-storage-contribution";
import { SETTINGS_FOLDER } from "../common/system-folder";
import { MainStorageService } from "./main-storage";

/** Theia's config directory (settings.json, keymaps…): the main storage's `/.shell/settings`. */
export const SHELL_SYSTEM_SCHEME = "shell-system";

@injectable()
export class ShellSystemFileServiceContribution implements FileServiceContribution {
  @inject(MainStorageService) protected readonly main!: MainStorageService;

  registerFileSystemProviders(service: FileService): void {
    service.onWillActivateFileSystemProvider((event) => {
      if (event.scheme !== SHELL_SYSTEM_SCHEME) return;
      service.registerProvider(
        SHELL_SYSTEM_SCHEME,
        new FilesApiFileSystemProvider(async () => new CompositeFilesApi((await this.main.open()).files, SETTINGS_FOLDER)),
      );
    });
  }
}

/** User storage reads the config directory through `shell-system`, not `file` (Theia hard-codes `file`). */
@injectable()
export class ShellUserStorageContribution extends UserStorageContribution {
  protected override getDelegate(service: FileService) {
    return service.activateProvider(SHELL_SYSTEM_SCHEME);
  }
}

/** Browser-only Theia's stub, with the config directory moved. */
export const shellEnvVariablesServer: EnvVariablesServer = {
  getExecPath: async () => "",
  getVariables: async () => [],
  getValue: async () => undefined,
  getConfigDirUri: async () => `${SHELL_SYSTEM_SCHEME}:///`,
  getHomeDirUri: async () => "file:///",
  getDrives: async () => [],
};
```
If `tsc` reports that `EnvVariablesServer` has more members in 1.76, add them with the same values as `node_modules/@theia/core/lib/browser-only/frontend-only-application-module.js` lines 91-100.

- [ ] **Step 6: Build and commit**

Run: `pnpm --filter @theia-shell/theia-files-mounts test && pnpm --filter @theia-shell/theia-files-mounts build`
Expected: 24 passed; build clean. (Binding happens in Task 8; the e2e checks in Task 9.)
```bash
git add packages/theia-files-mounts
git commit -m "theia-shell: main storage, its boot gate, and settings served as shell-system:

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `MountService`, preferences, labels, commands, and the module

**Files:**
- Create: `packages/theia-files-mounts/src/browser/mount-preferences.ts`
- Create: `packages/theia-files-mounts/src/browser/mount-service.ts`
- Create: `packages/theia-files-mounts/src/browser/mount-layers.ts`
- Create: `packages/theia-files-mounts/src/browser/mount-label-contribution.ts`
- Create: `packages/theia-files-mounts/src/browser/mount-commands.ts`
- Create: `packages/theia-files-mounts/src/browser/mounts-frontend-module.ts`
- Modify: `packages/theia-files-mounts/package.json` (add `theiaExtensions`)

**Interfaces:**
- Consumes: everything from Tasks 2–7; `CredentialsService`; `VaultService`, `VaultUi`, `VaultLocation`.
- Produces:
  - `MOUNT_SECRETS_SERVICE = "theia-shell.mounts"`
  - DI `MountDefaults` symbol: `{ mounts: MountConfig[]; hidden: string[] }` (default `{ mounts: [], hidden: [] }`; the app rebinds)
  - `MountService` with `start(): Promise<FilesApi>`, `root: MountedFilesApi`, `onDidChange: Event<readonly FilesApiChange[]>`, `onDidChangeStatus: Event<void>`, `types(): Map<string, MountType>`, `mainKey(): string | undefined`, `mountAt(uri: URI): MountConfig | undefined`, `status(key)`, `configuredMounts(): MountConfig[]`, `saveMount(config, secrets, previousKey?)`, `unmount(key)`, `reconnect(key)`
  - Module bindings: `FilesApiSource` → `() => mountService.start()`, `FilesApiChanges` → `mountService.onDidChange`, `VaultLocation` → main storage `/.shell`, `EnvVariablesServer` → `shellEnvVariablesServer`, `UserStorageContribution` → `ShellUserStorageContribution`, `FileServiceContribution` += `ShellSystemFileServiceContribution`.
  - Commands: `files.mount`, `files.mount.edit`, `files.unmount`, `files.mount.reconnect`, `files.chooseMainStorage`.

This task is wiring: its behaviour is asserted by Task 9's e2e tests, which are written before Task 9's app changes and must fail first.

- [ ] **Step 1: Preferences and defaults**

`src/browser/mount-preferences.ts`:
```ts
import { type PreferenceSchema, PreferenceScope } from "@theia/core/lib/common/preferences";
import type { MountConfig } from "../common/mount-types";

export const MOUNTS_PREFERENCE = "files.mounts";
export const HIDDEN_PREFERENCE = "files.hidden";
export const MOUNT_SECRETS_SERVICE = "theia-shell.mounts";

/** What an app shows when the preferences are unset. */
export const MountDefaults = Symbol("MountDefaults");
export interface MountDefaults {
  mounts: MountConfig[];
  hidden: string[];
}

export const mountPreferenceSchema: PreferenceSchema = {
  properties: {
    [MOUNTS_PREFERENCE]: {
      type: "array",
      scope: PreferenceScope.User,
      description:
        "File systems mounted as root folders, besides the main storage. Secrets are kept in the vault, not here.",
      items: {
        type: "object",
        required: ["key", "name", "type", "config"],
        properties: {
          key: { type: "string", description: "The folder name at the root." },
          name: { type: "string", description: "The name shown in the explorer." },
          type: { type: "string", description: "The mount type: memory, opfs, local-folder, s3, …" },
          config: { type: "object", additionalProperties: { type: "string" } },
        },
      },
    },
    [HIDDEN_PREFERENCE]: {
      type: "array",
      scope: PreferenceScope.User,
      items: { type: "string" },
      description: "Glob patterns of paths hidden everywhere: explorer, editors and search. Example: **/*.log",
    },
  },
};
```

- [ ] **Step 2: Layers bound in Theia**

`src/browser/mount-layers.ts`:
```ts
import type { FilesApi } from "@statewalker/webrun-files";
import { PreferenceService } from "@theia/core/lib/common/preferences";
import { inject, injectable } from "@theia/core/shared/inversify";
import { type FilesApiLayer, hiddenPathsFilter, systemFolderFilter } from "../common/layers";
import { SYSTEM_FOLDER } from "../common/system-folder";
import { MainStorageService } from "./main-storage";
import { HIDDEN_PREFERENCE, MountDefaults } from "./mount-preferences";

/** Always on: `/<main key>/.shell` is never in the file tree. */
@injectable()
export class SystemFolderLayer implements FilesApiLayer {
  readonly id = "system-folder";
  readonly priority = 0;
  @inject(MainStorageService) protected readonly main!: MainStorageService;

  wrap(root: FilesApi): FilesApi {
    const key = this.main.current?.storage.key;
    return systemFolderFilter(key ? `/${key}${SYSTEM_FOLDER}` : undefined)(root);
  }
}

/** The `files.hidden` globs (or the app's default). */
@injectable()
export class HiddenPathsLayer implements FilesApiLayer {
  readonly id = "hidden-paths";
  readonly priority = 10;
  @inject(PreferenceService) protected readonly preferences!: PreferenceService;
  @inject(MountDefaults) protected readonly defaults!: MountDefaults;

  wrap(root: FilesApi): FilesApi {
    const set = this.preferences.inspect<string[]>(HIDDEN_PREFERENCE)?.globalValue;
    return hiddenPathsFilter(Array.isArray(set) ? set : this.defaults.hidden)(root);
  }
}
```

- [ ] **Step 3: `MountService`**

`src/browser/mount-service.ts`:
```ts
import type { FilesApi } from "@statewalker/webrun-files";
import { CompositeFilesApi, readOnly } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { CredentialsService } from "@theia/core/lib/browser/credentials-service";
import { ContributionProvider } from "@theia/core/lib/common/contribution-provider";
import { Emitter, type Event } from "@theia/core/lib/common/event";
import { MessageService } from "@theia/core/lib/common/message-service";
import { PreferenceScope, PreferenceService } from "@theia/core/lib/common/preferences";
import type URI from "@theia/core/lib/common/uri";
import { inject, injectable, named } from "@theia/core/shared/inversify";
import type { FilesApiChange } from "@theia-shell/theia-files-api";
import { VaultService } from "@theia-shell/theia-secret-vault/lib/browser/vault-service";
import { applyLayers, FilesApiLayer } from "../common/layers";
import { validateMountConfigs } from "../common/mount-config";
import { type ApplyOptions, MountTable } from "../common/mount-table";
import { type MountConfig, type MountStatus, MountType } from "../common/mount-types";
import { MountedFilesApi } from "../common/mounted-files-api";
import { MainStorageService } from "./main-storage";
import { MOUNT_SECRETS_SERVICE, MOUNTS_PREFERENCE, HIDDEN_PREFERENCE, MountDefaults } from "./mount-preferences";

/**
 * Owns the root FilesApi: the main storage plus the `files.mounts` mounts,
 * wrapped in the layers. `start()` resolves as soon as the main storage is
 * open — it never waits for preferences, because folder-scope preferences are
 * read through this root — and the other mounts follow as reported changes.
 */
@injectable()
export class MountService {
  @inject(MainStorageService) protected readonly main!: MainStorageService;
  @inject(PreferenceService) protected readonly preferences!: PreferenceService;
  @inject(CredentialsService) protected readonly credentials!: CredentialsService;
  @inject(VaultService) protected readonly vaults!: VaultService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(MountDefaults) protected readonly defaults!: MountDefaults;
  @inject(ContributionProvider) @named(MountType) protected readonly typeProvider!: ContributionProvider<MountType>;
  @inject(ContributionProvider) @named(FilesApiLayer) protected readonly layerProvider!: ContributionProvider<FilesApiLayer>;

  readonly root = new MountedFilesApi(new CompositeFilesApi(readOnly(new MemFilesApi())));
  protected readonly table = new MountTable(
    (id) => this.types().get(id),
    (mount, field) => this.credentials.getPassword(MOUNT_SECRETS_SERVICE, `${mount.key}/${field}`),
    () => !this.vaults.current?.unlocked,
  );
  protected mainMount: { config: MountConfig; api: FilesApi } | undefined;
  protected started: Promise<FilesApi> | undefined;
  protected readonly reported = new Set<string>();
  protected queue: Promise<void> = Promise.resolve();

  protected readonly changeEmitter = new Emitter<readonly FilesApiChange[]>();
  readonly onDidChange: Event<readonly FilesApiChange[]> = this.changeEmitter.event;
  protected readonly statusEmitter = new Emitter<void>();
  readonly onDidChangeStatus: Event<void> = this.statusEmitter.event;

  start(): Promise<FilesApi> {
    this.started ??= this.doStart();
    return this.started;
  }

  protected async doStart(): Promise<FilesApi> {
    const opened = await this.main.open();
    const { key, name } = opened.storage;
    this.mainMount = { config: { key, name, type: "main", config: {} }, api: opened.files };
    await this.apply([]);
    void this.preferences.ready.then(() => this.applyPreferences());
    this.preferences.onPreferenceChanged((event) => {
      if (event.preferenceName === MOUNTS_PREFERENCE) void this.applyPreferences();
      if (event.preferenceName === HIDDEN_PREFERENCE) this.rebuild([{ type: "updated", path: "/" }]);
    });
    this.vaults.onDidUnlock(() => void this.applyPreferences({ recreate: (_key, s) => s.state === "locked" }));
    for (const layer of this.layerProvider.getContributions()) {
      layer.onDidChange?.(() => this.rebuild([{ type: "updated", path: "/" }]));
    }
    return this.root;
  }

  types(): Map<string, MountType> {
    return new Map(this.typeProvider.getContributions().map((t) => [t.id, t]));
  }

  mainKey(): string | undefined {
    return this.mainMount?.config.key;
  }

  status(key: string): MountStatus | undefined {
    return this.table.status(key);
  }

  /** The mount a root-level folder URI stands for (main included). */
  mountAt(uri: URI): MountConfig | undefined {
    const segments = uri.path.toString().split("/").filter(Boolean);
    if (segments.length !== 1) return undefined;
    return this.table.configs().find((c) => c.key === segments[0]);
  }

  /** `files.mounts` as set, or the app's defaults when unset. */
  configuredMounts(): MountConfig[] {
    const set = this.preferences.inspect<MountConfig[]>(MOUNTS_PREFERENCE)?.globalValue;
    return Array.isArray(set) ? set : this.defaults.mounts;
  }

  /** Adds or replaces a mount (and its secrets), then saves `files.mounts`. */
  async saveMount(config: MountConfig, secrets: Record<string, string>, previousKey?: string): Promise<void> {
    const type = this.types().get(config.type);
    const secretFields = type?.fields.filter((f) => f.kind === "secret").map((f) => f.name) ?? [];
    if (previousKey && previousKey !== config.key) {
      for (const field of secretFields) {
        if (field in secrets) continue;
        const value = await this.credentials.getPassword(MOUNT_SECRETS_SERVICE, `${previousKey}/${field}`);
        if (value !== undefined) secrets[field] = value;
        await this.credentials.deletePassword(MOUNT_SECRETS_SERVICE, `${previousKey}/${field}`);
      }
    }
    for (const [field, value] of Object.entries(secrets)) {
      await this.credentials.setPassword(MOUNT_SECRETS_SERVICE, `${config.key}/${field}`, value);
    }
    const list = this.configuredMounts();
    const index = list.findIndex((m) => m.key === (previousKey ?? config.key));
    const next = [...list];
    if (index >= 0) next.splice(index, 1, config);
    else next.push(config);
    await this.preferences.set(MOUNTS_PREFERENCE, next, PreferenceScope.User);
  }

  async unmount(key: string): Promise<void> {
    const config = this.configuredMounts().find((m) => m.key === key);
    if (!config) return;
    const type = this.types().get(config.type);
    for (const field of type?.fields.filter((f) => f.kind === "secret") ?? []) {
      await this.credentials.deletePassword(MOUNT_SECRETS_SERVICE, `${key}/${field.name}`);
    }
    await type?.forget?.(config);
    await this.preferences.set(
      MOUNTS_PREFERENCE,
      this.configuredMounts().filter((m) => m.key !== key),
      PreferenceScope.User,
    );
  }

  /** From a click: re-creates one mount with `interactive` true (grants folder access). */
  reconnect(key: string): Promise<void> {
    return this.applyPreferences({ interactive: true, recreate: (k) => k === key });
  }

  protected applyPreferences(options: ApplyOptions = {}): Promise<void> {
    const reserved = this.mainKey() ? [this.mainKey() as string] : [];
    const { valid, errors } = validateMountConfigs(this.configuredMounts(), this.types(), reserved);
    for (const error of errors) {
      if (this.reported.has(error)) continue;
      this.reported.add(error);
      this.messages.warn(`Mounts: ${error}`);
    }
    return this.apply(valid, options);
  }

  /** Serialized: a slow S3 mount must not let an older apply overwrite a newer one. */
  protected apply(configs: MountConfig[], options: ApplyOptions = {}): Promise<void> {
    this.queue = this.queue.then(async () => {
      const fixed = this.mainMount ? [this.mainMount] : [];
      this.rebuild(await this.table.apply(configs, { ...options, fixed }));
    });
    return this.queue;
  }

  protected rebuild(changes: FilesApiChange[]): void {
    this.root.setTarget(applyLayers(this.table.composite(), this.layerProvider.getContributions()));
    if (changes.length) this.changeEmitter.fire(changes);
    this.statusEmitter.fire();
  }
}
```

- [ ] **Step 4: Labels**

`src/browser/mount-label-contribution.ts`:
```ts
import type { DidChangeLabelEvent, LabelProviderContribution } from "@theia/core/lib/browser/label-provider";
import { Emitter } from "@theia/core/lib/common/event";
import URI from "@theia/core/lib/common/uri";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import { FileStat } from "@theia/filesystem/lib/common/files";
import type { MountStatus } from "../common/mount-types";
import { MountService } from "./mount-service";

/** A root folder shows its mount's name and status: "Cloud (locked)". */
@injectable()
export class MountLabelContribution implements LabelProviderContribution {
  @inject(MountService) protected readonly mounts!: MountService;
  protected readonly changes = new Emitter<DidChangeLabelEvent>();
  readonly onDidChange = this.changes.event;

  @postConstruct()
  protected init(): void {
    this.mounts.onDidChangeStatus(() => this.changes.fire({ affects: (e) => !!this.mountOf(e) }));
  }

  canHandle(element: object): number {
    return this.mountOf(element) ? 200 : 0;
  }

  getName(element: object): string | undefined {
    const mount = this.mountOf(element);
    if (!mount) return undefined;
    return `${mount.name}${suffix(this.mounts.status(mount.key))}`;
  }

  protected mountOf(element: object) {
    const uri = element instanceof URI ? element : FileStat.is(element) ? element.resource : undefined;
    return uri?.scheme === "file" ? this.mounts.mountAt(uri) : undefined;
  }
}

function suffix(status: MountStatus | undefined): string {
  switch (status?.state) {
    case "failed":
      return ` (unavailable: ${status.message})`;
    case "needs-access":
      return " (click Reconnect)";
    case "locked":
      return " (locked)";
    default:
      return "";
  }
}
```

- [ ] **Step 5: Commands and the wizard**

`src/browser/mount-commands.ts`:
```ts
import { ConfirmDialog } from "@theia/core/lib/browser/dialogs";
import type { Command, CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import type { MenuContribution, MenuModelRegistry } from "@theia/core/lib/common/menu";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/common/quick-pick-service";
import { SelectionService } from "@theia/core/lib/common/selection-service";
import type URI from "@theia/core/lib/common/uri";
import { UriAwareCommandHandler } from "@theia/core/lib/common/uri-command-handler";
import { inject, injectable } from "@theia/core/shared/inversify";
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { NAVIGATOR_CONTEXT_MENU, NavigatorContextMenu } from "@theia/navigator/lib/browser/navigator-contribution";
import { VaultUi } from "@theia-shell/theia-secret-vault/lib/browser/vault-contribution";
import { suggestKey, validateKey } from "../common/mount-keys";
import type { MountConfig, MountType } from "../common/mount-types";
import { copySystemFolder, hasSystemFolder } from "../common/system-folder";
import { DEFAULT_MAIN, MainStorageService } from "./main-storage";
import { MountService } from "./mount-service";

export namespace MountCommands {
  const category = "Files";
  export const MOUNT: Command = { id: "files.mount", category, label: "Mount File System…" };
  export const EDIT: Command = { id: "files.mount.edit", category, label: "Edit Mount…" };
  export const UNMOUNT: Command = { id: "files.unmount", category, label: "Unmount" };
  export const RECONNECT: Command = { id: "files.mount.reconnect", category, label: "Reconnect" };
  export const CHOOSE_MAIN: Command = { id: "files.chooseMainStorage", category, label: "Choose Main Storage…" };
}

@injectable()
export class MountCommandContribution implements CommandContribution, MenuContribution {
  @inject(MountService) protected readonly mounts!: MountService;
  @inject(MainStorageService) protected readonly main!: MainStorageService;
  @inject(QuickInputService) protected readonly quick!: QuickInputService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(VaultUi) protected readonly vaultUi!: VaultUi;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(MountCommands.MOUNT, { execute: () => this.wizard() });
    const onMount = (run: (mount: MountConfig) => unknown, show: (mount: MountConfig) => boolean) =>
      UriAwareCommandHandler.MonoSelect(this.selection, {
        execute: (uri: URI) => {
          const mount = this.mounts.mountAt(uri);
          return mount && run(mount);
        },
        isVisible: (uri: URI) => {
          const mount = this.mounts.mountAt(uri);
          return !!mount && show(mount);
        },
      });
    const notMain = (m: MountConfig) => m.key !== this.mounts.mainKey();
    commands.registerCommand(MountCommands.EDIT, onMount((m) => this.wizard(m), notMain));
    commands.registerCommand(MountCommands.UNMOUNT, onMount((m) => this.unmount(m), notMain));
    commands.registerCommand(
      MountCommands.RECONNECT,
      onMount(
        (m) => this.mounts.reconnect(m.key),
        (m) => ["needs-access", "failed"].includes(this.mounts.status(m.key)?.state ?? ""),
      ),
    );
    commands.registerCommand(MountCommands.CHOOSE_MAIN, { execute: () => this.chooseMain() });
  }

  registerMenus(menus: MenuModelRegistry): void {
    const group = [...NAVIGATOR_CONTEXT_MENU, "7_mounts"];
    menus.registerMenuAction(group, { commandId: MountCommands.RECONNECT.id, order: "a" });
    menus.registerMenuAction(group, { commandId: MountCommands.EDIT.id, order: "b" });
    menus.registerMenuAction(group, { commandId: MountCommands.UNMOUNT.id, order: "c" });
    menus.registerMenuAction(NavigatorContextMenu.NAVIGATION, { commandId: MountCommands.MOUNT.id, order: "z" });
  }

  /** New mount, or `existing` edited (its type fixed). */
  protected async wizard(existing?: MountConfig): Promise<void> {
    const types = [...this.mounts.types().values()].filter((t) => t.isAvailable());
    const type: MountType | undefined = existing
      ? this.mounts.types().get(existing.type)
      : (await this.quick.pick(types.map((t) => ({ label: t.label, type: t })), { placeHolder: "Type of file system to mount" }))?.type;
    if (!type) return;
    const taken = [
      ...(this.mounts.mainKey() ? [this.mounts.mainKey() as string] : []),
      ...this.mounts.configuredMounts().map((m) => m.key).filter((k) => k !== existing?.key),
    ];
    const name = await this.quick.input({
      prompt: "Name shown in the explorer",
      value: existing?.name ?? "",
      validateInput: async (v) => (v.trim() ? undefined : "A name is required."),
    });
    if (name === undefined) return;
    const keyInput = await this.quick.input({
      prompt: "Key: the folder name at the root",
      value: existing?.key ?? suggestKey(name.trim(), taken),
      validateInput: async (v) => validateKey(v.trim(), taken),
    });
    if (keyInput === undefined) return;
    const key = keyInput.trim();
    const config: Record<string, string> = { ...(existing?.config ?? {}) };
    const secrets: Record<string, string> = {};
    for (const field of type.fields) {
      const secret = field.kind === "secret";
      const fallback = typeof field.default === "function" ? field.default({ key, name }) : (field.default ?? "");
      const keepSecret = secret && !!existing;
      const value = await this.quick.input({
        prompt: field.label,
        password: secret,
        value: secret ? "" : (config[field.name] ?? fallback),
        placeHolder: keepSecret ? "Leave empty to keep the current value" : undefined,
        validateInput: async (v) => {
          if (field.required && !v.trim() && !keepSecret) return `${field.label} is required.`;
          if (field.kind === "url" && v.trim() && !/^https?:\/\/[^/]/.test(v.trim())) return "Enter an http:// or https:// URL.";
          return undefined;
        },
      });
      if (value === undefined) return;
      if (secret) {
        if (value) secrets[field.name] = value;
      } else if (value.trim()) config[field.name] = value.trim();
      else delete config[field.name];
    }
    if (type.configure) {
      const extra = await type.configure({ key, name: name.trim(), type: type.id, config });
      if (!extra) return;
      Object.assign(config, extra);
    }
    if (type.fields.some((f) => f.kind === "secret") && !(await this.vaultUi.ensureUnlocked())) {
      this.messages.warn("Secrets are locked, so the mount was not saved. Run “Secrets: Unlock” and try again.");
      return;
    }
    await this.mounts.saveMount({ key, name: name.trim(), type: type.id, config }, secrets, existing?.key);
  }

  protected async unmount(mount: MountConfig): Promise<void> {
    const ok = await new ConfirmDialog({
      title: `Unmount “${mount.name}”?`,
      msg: "The files stay where they are; only the mount point is removed.",
      ok: "Unmount",
    }).open();
    if (ok) await this.mounts.unmount(mount.key);
  }

  protected async chooseMain(): Promise<void> {
    const pick = await this.quick.pick(
      [
        { label: "Browser Storage (OPFS)", id: "opfs" },
        { label: "A Folder on this Computer…", id: "local-folder" },
      ],
      { placeHolder: "Where to keep your files and settings" },
    );
    if (!pick) return;
    const current = await this.main.open();
    if (pick.id === "opfs") {
      await this.main.choose(DEFAULT_MAIN);
      window.location.reload();
      return;
    }
    const picker = (window as unknown as { showDirectoryPicker(o: { mode: "readwrite" }): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await picker({ mode: "readwrite" });
    } catch {
      return;
    }
    const target = new BrowserFilesApi({ rootHandle: handle });
    if (!(await hasSystemFolder(target))) {
      const copy = await this.quick.pick(
        [
          { label: "Copy my current settings and secrets", id: "copy" },
          { label: "Start with empty settings", id: "empty" },
        ],
        { placeHolder: `“${handle.name}” has no settings yet` },
      );
      if (!copy) return;
      if (copy.id === "copy") await copySystemFolder(current.files, target);
    }
    const taken = this.mounts.configuredMounts().map((m) => m.key);
    await this.main.choose({ type: "local-folder", key: suggestKey(handle.name, taken), name: handle.name, handle });
    window.location.reload();
  }
}
```

- [ ] **Step 6: The module**

`src/browser/mounts-frontend-module.ts`:
```ts
import { LabelProviderContribution } from "@theia/core/lib/browser/label-provider";
import { bindContributionProvider } from "@theia/core/lib/common/contribution-provider";
import { CommandContribution } from "@theia/core/lib/common/command";
import { EnvVariablesServer } from "@theia/core/lib/common/env-variables";
import { MenuContribution } from "@theia/core/lib/common/menu";
import { PreferenceContribution } from "@theia/core/lib/common/preferences";
import { ContainerModule, type interfaces } from "@theia/core/shared/inversify";
import { FileServiceContribution } from "@theia/filesystem/lib/browser/file-service";
import { FilesApiChanges, FilesApiSource } from "@theia-shell/theia-files-api";
import { VaultLocation } from "@theia-shell/theia-secret-vault/lib/browser/vault-service";
import { UserStorageContribution } from "@theia/userstorage/lib/browser/user-storage-contribution";
import { FilesApiLayer } from "../common/layers";
import { MountType } from "../common/mount-types";
import { SYSTEM_FOLDER } from "../common/system-folder";
import { MainStorageService } from "./main-storage";
import { MountCommandContribution } from "./mount-commands";
import { MountLabelContribution } from "./mount-label-contribution";
import { HiddenPathsLayer, SystemFolderLayer } from "./mount-layers";
import { MountDefaults, mountPreferenceSchema } from "./mount-preferences";
import { MountService } from "./mount-service";
import { LocalFolderMountType } from "./mount-types/local-folder-mount-type";
import { MemoryMountType } from "./mount-types/memory-mount-type";
import { OpfsMountType } from "./mount-types/opfs-mount-type";
import {
  ShellSystemFileServiceContribution,
  ShellUserStorageContribution,
  shellEnvVariablesServer,
} from "./system-storage";

/**
 * The app's file system as mounts over a main storage. Loads after
 * theia-files-api, theia-secret-vault, @theia/userstorage and @theia/core (it
 * depends on them), so its rebinds win.
 */
export default new ContainerModule((bind, _unbind, isBound, rebind) => {
  bind(MainStorageService).toSelf().inSingletonScope();
  bind(MountService).toSelf().inSingletonScope();
  bind(MountDefaults).toConstantValue({ mounts: [], hidden: [] });

  bindContributionProvider(bind, MountType);
  for (const type of [MemoryMountType, OpfsMountType, LocalFolderMountType]) {
    bind(type).toSelf().inSingletonScope();
    bind(MountType).toService(type);
  }
  bindContributionProvider(bind, FilesApiLayer);
  for (const layer of [SystemFolderLayer, HiddenPathsLayer]) {
    bind(layer).toSelf().inSingletonScope();
    bind(FilesApiLayer).toService(layer);
  }

  bind(PreferenceContribution).toConstantValue({ schema: mountPreferenceSchema });

  const rebindOrBind = (id: interfaces.ServiceIdentifier<unknown>) => (isBound(id) ? rebind(id) : bind(id));
  rebindOrBind(FilesApiSource).toDynamicValue(({ container }) => () => container.get(MountService).start());
  rebindOrBind(FilesApiChanges).toDynamicValue(({ container }) => container.get(MountService).onDidChange);
  rebindOrBind(VaultLocation).toDynamicValue(({ container }) => async () => {
    const main = await container.get(MainStorageService).open();
    return { files: main.files, dir: SYSTEM_FOLDER, persistent: main.persistent };
  });
  rebindOrBind(EnvVariablesServer).toConstantValue(shellEnvVariablesServer);
  rebind(UserStorageContribution).to(ShellUserStorageContribution).inSingletonScope();
  bind(ShellSystemFileServiceContribution).toSelf().inSingletonScope();
  bind(FileServiceContribution).toService(ShellSystemFileServiceContribution);

  bind(MountLabelContribution).toSelf().inSingletonScope();
  bind(LabelProviderContribution).toService(MountLabelContribution);
  bind(MountCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(MountCommandContribution);
  bind(MenuContribution).toService(MountCommandContribution);
});
```
Add to `package.json`:
```json
  "theiaExtensions": [
    {
      "frontend": "lib/browser/mounts-frontend-module",
      "frontendOnly": "lib/browser/mounts-frontend-module"
    }
  ],
```
Add `@theia-shell/theia-files-mounts` to `app/package.json` `dependencies` and both build filter lists.

Also grep the app's Theia packages for other hand-built config paths (the spec's risk):
```bash
grep -rln "file:///.theia\|'.theia'" node_modules/@theia/*/lib/browser* | grep -v "\.map$"
```
Every hit that is not resolved through `getConfigDirUri()` goes in the package README's *Known gaps*.

- [ ] **Step 7: Build**

Run: `pnpm install && pnpm build`
Expected: clean. Do not run e2e yet; Task 9 writes them first.

- [ ] **Step 8: Commit**

```bash
git add packages/theia-files-mounts app/package.json pnpm-lock.yaml
git commit -m "theia-shell: MountService, mount preferences, labels and commands

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The app on mounts — defaults, seeding, and end-to-end tests

**Files:**
- Modify: `app/files/src/app-files-frontend-module.ts`
- Modify: `app/files/package.json` (description, dependencies)
- Modify: `app/tests/helpers.ts`, `app/tests/files.spec.ts`, `app/tests/markdown.spec.ts`, `app/tests/viewers.spec.ts`
- Create: `app/tests/mounts.spec.ts`, `app/tests/vault.spec.ts`

**Interfaces:**
- Consumes: `MountDefaults`, `MainStorageService`, `MountService`, `FilesApiSource` binding from Task 8.
- Produces: `window.theiaShell.filesApi` = the filtered root; test helpers `start(page, query?, { password? })`, `unlockVault(page, password)`, `openMain(page)`.

- [ ] **Step 1: Write the failing e2e tests**

Replace `app/tests/helpers.ts`'s `start` and `readFile` with:
```ts
export const MAIN = "Browser Storage";

/**
 * Opens the app and the main storage. With OPFS (no `storage=memory`) the
 * first visit asks for a new vault password; it is answered with `password`.
 */
export async function start(page: Page, query = "", { password = "test-password" }: { password?: string } = {}) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
  await page.goto(`/${query}`);
  if (!query.includes("storage=memory")) await unlockVault(page, password);
  await openMain(page);
  return errors;
}

export async function openMain(page: Page) {
  const main = explorer(page).getByText(MAIN, { exact: true });
  await expect(main).toBeVisible();
  const welcome = explorer(page).getByText("welcome.md", { exact: true });
  if (!(await welcome.isVisible())) await main.click();
  await expect(welcome).toBeVisible();
}

/** Creates or unlocks the vault through its dialog. */
export async function unlockVault(page: Page, password: string, remember = false) {
  const dialog = page.locator(".vault-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".vault-password").fill(password);
  const confirm = dialog.locator(".vault-password-confirm");
  if (await confirm.count()) await confirm.fill(password);
  if (remember) await dialog.locator(".vault-remember").check();
  await dialog.locator(".theia-button.main").click();
  await expect(dialog).toHaveCount(0);
}
```
Then, in the existing specs:
- every `readFile(page, "/x")` becomes `readFile(page, "/browser/x")` (the demo files now live in the main mount);
- `openFile(page, ...)` calls stay as they are: `start` has already expanded "Browser Storage", and the helper clicks the remaining folder names;
- `files.spec.ts` "the default OPFS storage keeps saved edits across a reload": after `page.reload()`, add `await unlockVault(page, "test-password"); await openMain(page);`;
- `files.spec.ts` root-label test: additionally assert `await expect(explorer(page).getByText("Browser Storage", { exact: true })).toBeVisible();`.

`app/tests/mounts.spec.ts`:
```ts
import { expect, test } from "@playwright/test";
import { explorer, openMain, readFile, runFromPalette, start, unlockVault } from "./helpers";

async function mountMemory(page: import("@playwright/test").Page, name: string, key?: string) {
  await runFromPalette(page, "Files: Mount File System…");
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "In Memory" }).click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  await input.fill(name);
  await page.keyboard.press("Enter");
  if (key !== undefined) await input.fill(key);
  await page.keyboard.press("Enter");
}

test("the main storage and the default Temporary mount show by name", async ({ page }) => {
  const errors = await start(page, "?storage=memory");
  await expect(explorer(page).getByText("Temporary", { exact: true })).toBeVisible();
  await expect(explorer(page).getByText(".shell", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the wizard mounts a memory file system with a key from its name", async ({ page }) => {
  const errors = await start(page, "?storage=memory");
  await mountMemory(page, "Scratch Pad");
  await expect(explorer(page).getByText("Scratch Pad", { exact: true })).toBeVisible();
  const mounts = await page.evaluate(async () => {
    const files = (window as unknown as { theiaShell: { filesApi: { list(p: string): AsyncIterable<{ name: string }> } } }).theiaShell.filesApi;
    const names: string[] = [];
    for await (const e of files.list("/")) names.push(e.name);
    return names;
  });
  expect(mounts).toContain("scratch-pad");
  expect(errors).toEqual([]);
});

test("a name in another script gets the key 'mount' and keeps its name", async ({ page }) => {
  await start(page, "?storage=memory");
  await mountMemory(page, "Мой диск");
  await expect(explorer(page).getByText("Мой диск", { exact: true })).toBeVisible();
});

test("a duplicate key is refused", async ({ page }) => {
  await start(page, "?storage=memory");
  await runFromPalette(page, "Files: Mount File System…");
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "In Memory" }).click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  await input.fill("Anything");
  await page.keyboard.press("Enter");
  await input.fill("temp");
  await expect(page.locator(".quick-input-message")).toContainText("already used");
});

test("Edit renames, Unmount removes", async ({ page }) => {
  await start(page, "?storage=memory");
  await mountMemory(page, "Scratch Pad");
  const folder = explorer(page).getByText("Scratch Pad", { exact: true });
  await folder.click({ button: "right" });
  await page.locator(".lm-Menu-itemLabel", { hasText: "Edit Mount…" }).click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  await input.fill("Renamed");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(explorer(page).getByText("Renamed", { exact: true })).toBeVisible();
  await explorer(page).getByText("Renamed", { exact: true }).click({ button: "right" });
  await page.locator(".lm-Menu-itemLabel", { hasText: "Unmount" }).click();
  await page.locator(".dialogBlock .theia-button.main").click();
  await expect(explorer(page).getByText("Renamed", { exact: true })).toHaveCount(0);
});

test("files.hidden hides a path everywhere, live", async ({ page }) => {
  await start(page, "?storage=memory");
  await expect(explorer(page).getByText("welcome.md", { exact: true })).toBeVisible();
  await runFromPalette(page, "Preferences: Open Settings (JSON)");
  const editor = page.locator(".theia-editor .monaco-editor").last();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText('{ "files.hidden": ["**/welcome.md"] }');
  await page.keyboard.press("Control+s");
  await expect(explorer(page).getByText("welcome.md", { exact: true })).toHaveCount(0);
  expect(await readFile(page, "/browser/welcome.md")).toBeUndefined();
});

test("a malformed files.mounts entry is skipped with a warning; the others mount", async ({ page }) => {
  await start(page, "?storage=memory");
  await runFromPalette(page, "Preferences: Open Settings (JSON)");
  const editor = page.locator(".theia-editor .monaco-editor").last();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(
    '{ "files.mounts": [ { "name": "No key", "type": "memory", "config": {} }, { "key": "ok", "name": "Fine", "type": "memory", "config": {} } ] }',
  );
  await page.keyboard.press("Control+s");
  await expect(explorer(page).getByText("Fine", { exact: true })).toBeVisible();
  await expect(page.locator(".theia-notification-message").filter({ hasText: "missing key" })).toBeVisible();
});

test("an OPFS mount and its files survive a reload", async ({ page }) => {
  await start(page, "", { password: "test-password" });
  await runFromPalette(page, "Files: Mount File System…");
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "Browser Storage (OPFS)" }).click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  await input.fill("Drafts");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // key: drafts
  await page.keyboard.press("Enter"); // directory: drafts
  await expect(explorer(page).getByText("Drafts", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const files = (window as unknown as { theiaShell: { filesApi: { write(p: string, c: Uint8Array[]): Promise<void> } } }).theiaShell.filesApi;
    await files.write("/drafts/idea.md", [new TextEncoder().encode("# idea")]);
  });
  await page.reload();
  await unlockVault(page, "test-password");
  await openMain(page);
  await expect(explorer(page).getByText("Drafts", { exact: true })).toBeVisible();
  expect(await readFile(page, "/drafts/idea.md")).toBe("# idea");
});

test("a local folder mounts through the picker and reconnects after a reload", async ({ page }) => {
  // Playwright cannot drive the native picker: hand out an OPFS directory instead.
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("picked", { create: true });
  });
  await start(page, "", { password: "test-password" });
  await runFromPalette(page, "Files: Mount File System…");
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "Folder on this Computer" }).click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  await input.fill("Local Computer");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(explorer(page).getByText("Local Computer", { exact: true })).toBeVisible();
  await page.reload();
  await unlockVault(page, "test-password");
  await openMain(page);
  await expect(explorer(page).getByText(/^Local Computer/)).toBeVisible();
});
```

`app/tests/vault.spec.ts`:
```ts
import { expect, test } from "@playwright/test";
import { explorer, openMain, runFromPalette, start, unlockVault } from "./helpers";

test("the first OPFS run creates the vault; the next asks for the password", async ({ page }) => {
  await start(page, "", { password: "first-password" });
  await page.reload();
  const dialog = page.locator(".vault-dialog");
  await expect(dialog.locator(".vault-password-confirm")).toHaveCount(0);
  await dialog.locator(".vault-password").fill("wrong");
  await dialog.locator(".theia-button.main").click();
  await expect(dialog.locator(".vault-message")).toContainText("Wrong password");
  await dialog.locator(".vault-password").fill("first-password");
  await dialog.locator(".theia-button.main").click();
  await expect(dialog).toHaveCount(0);
  await openMain(page);
});

test("Remember on this device skips the prompt next time", async ({ page }) => {
  await page.goto("/");
  await unlockVault(page, "pw", true);
  await openMain(page);
  await page.reload();
  await openMain(page);
  await expect(page.locator(".vault-dialog")).toHaveCount(0);
});

test("an empty password is refused when creating the vault", async ({ page }) => {
  await page.goto("/");
  const dialog = page.locator(".vault-dialog");
  await dialog.locator(".theia-button.main").click();
  await expect(dialog.locator(".dialogErrorMessage")).toContainText("Enter a password");
});

test("settings.json lives in the main storage's .shell, not in the file tree", async ({ page }) => {
  await start(page, "", { password: "pw" });
  await runFromPalette(page, "Preferences: Open Settings (JSON)");
  const editor = page.locator(".theia-editor .monaco-editor").last();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText('{ "files.hidden": ["**/*.tmp"] }');
  await page.keyboard.press("Control+s");
  const raw = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const main = await root.getDirectoryHandle("main");
    const shell = await main.getDirectoryHandle(".shell");
    const settings = await shell.getDirectoryHandle("settings");
    return (await (await settings.getFileHandle("settings.json")).getFile()).text();
  });
  expect(raw).toContain("**/*.tmp");
});

test("a local-folder main needs a click after a reload; the fallback opens browser storage", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("home", { create: true });
  });
  await start(page, "", { password: "pw" });
  await runFromPalette(page, "Files: Choose Main Storage…");
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "A Folder on this Computer" }).click();
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "Copy my current settings" }).click();
  await page.waitForEvent("load");
  // OPFS handles report "granted", so no gate: the app opens straight on the folder "home",
  // with the copied settings and vault (same password) and the demo files seeded into it.
  await expect(page.locator(".boot-gate")).toHaveCount(0);
  await unlockVault(page, "pw");
  await expect(explorer(page).getByText("home", { exact: true })).toBeVisible();
  await expect(explorer(page).getByText("Browser Storage", { exact: true })).toHaveCount(0);
});
```
(With OPFS handles standing in for a picked folder the permission is always "granted", so the gate itself is driven directly by the test in Step 4.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @theia-shell/app build && pnpm --filter @theia-shell/app test:e2e`
Expected: FAIL — the app still binds its own `FilesApiSource` (no "Browser Storage" folder, no vault dialog). Record the red count.

- [ ] **Step 3: Switch the app to mounts**

Replace `app/files/src/app-files-frontend-module.ts`:
```ts
import type { FilesApi } from "@statewalker/webrun-files";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { ContainerModule, inject, injectable } from "@theia/core/shared/inversify";
import { FilesApiRootLabel } from "@theia-shell/theia-files-api";
import { bootGate } from "@theia-shell/theia-files-mounts/lib/browser/boot-gate";
import { MainStorageInitializer } from "@theia-shell/theia-files-mounts/lib/browser/main-storage";
import { MountDefaults } from "@theia-shell/theia-files-mounts/lib/browser/mount-preferences";
import { MountService } from "@theia-shell/theia-files-mounts/lib/browser/mount-service";
import { SEED } from "./seed";
import { seedIfEmpty } from "./seed-if-empty";

/** For the e2e tests and the devtools console: the filtered root, and the boot gate. */
@injectable()
class ExposeForTests implements FrontendApplicationContribution {
  @inject(MountService) protected readonly mounts!: MountService;

  async onStart(): Promise<void> {
    const filesApi: FilesApi = await this.mounts.start();
    (window as unknown as { theiaShell: object }).theiaShell = { filesApi, bootGate };
  }
}

/**
 * The app's file system: mounts over a main storage (theia-files-mounts).
 * This module only sets the app's defaults and seeds the main storage with
 * the demo files the first time (before anything lists it).
 */
export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  rebind(MountDefaults).toConstantValue({
    mounts: [{ key: "temp", name: "Temporary", type: "memory", config: {} }],
    hidden: ["**/.git", "**/.git/**", "**/.DS_Store"],
  });
  bind(MainStorageInitializer).toConstantValue(async ({ files }: { files: FilesApi }) => {
    await seedIfEmpty(files, SEED);
  });
  rebind(FilesApiRootLabel).toConstantValue("Files");
  bind(ExposeForTests).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ExposeForTests);
});
```
Change `seedIfEmpty` so it ignores the system folder when deciding "empty": in `app/files/src/seed-if-empty.ts` replace the emptiness loop with
```ts
  for await (const entry of files.list("/")) if (entry.name !== ".shell") return false;
```
and add a unit test in `app/files/tests/seed.test.ts`: "a storage holding only `.shell` counts as empty".

`app/files/package.json`: description "The app's file-system defaults: a Temporary memory mount, hidden .git/.DS_Store, and the demo files seeded into the main storage."; dependencies: add `"@theia-shell/theia-files-mounts": "workspace:*"`, remove `@statewalker/webrun-files-browser` if nothing imports it any more.

`app/files/package.json` must list `@theia-shell/theia-files-mounts` so the module order puts app-files after it (its `rebind(MountDefaults)` needs the binding to exist).

- [ ] **Step 4: A DOM test for the boot gate**

The boot gate is plain DOM; drive it directly in a page with no app. Add to `app/tests/vault.spec.ts`:
```ts
test("the boot gate: a denied click stays, the fallback resolves", async ({ page }) => {
  await page.goto("/?storage=memory");
  const result = await page.evaluate(async () => {
    const { bootGate } = (window as unknown as { theiaShell: { bootGate: typeof import("@theia-shell/theia-files-mounts/lib/browser/boot-gate").bootGate } }).theiaShell;
    const pending = bootGate("Home", async () => false, async () => true);
    (document.querySelector(".boot-gate-open") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    const text = document.querySelector(".boot-gate p")?.textContent;
    (document.querySelector(".boot-gate-fallback") as HTMLButtonElement).click();
    return { text, choice: await pending };
  });
  expect(result.text).toContain("not granted");
  expect(result.choice).toBe("fallback");
});
```
(`bootGate` is exposed on `window.theiaShell` by the app module in Step 3.)

- [ ] **Step 5: Run everything**

Run: `pnpm build && pnpm test && pnpm --filter @theia-shell/app test:e2e`
Expected: all unit tests pass; all app e2e pass (the 18 existing, updated, plus the new ones). Fix the code, not the tests, unless a test's locator is wrong (say which in the README red/green log).

- [ ] **Step 6: Commit**

```bash
git add app packages
git commit -m "theia-shell: the app runs on mounts over a main storage with a vault

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The S3 mount type, end to end against RustFS

**Files:**
- Create: `packages/theia-files-s3/src/common/s3-options.ts`
- Create: `packages/theia-files-s3/src/browser/s3-mount-type.ts`
- Create: `packages/theia-files-s3/src/browser/s3-frontend-module.ts`
- Modify: `packages/theia-files-s3/package.json` (dependencies, `theiaExtensions`), `src/common/index.ts`
- Test: `packages/theia-files-s3/tests/s3-options.test.ts`
- Create: `app/tests/s3.spec.ts`
- Modify: `app/package.json`

**Interfaces:**
- Consumes: `MountType`, `SecretsLocked`, `MountConfig`, `MountContext` (Task 5); `startRustFs`, `hasDocker` (Task 1).
- Produces: `s3ClientOptions(config: Record<string, string>, secrets: { accessKeyId: string; secretAccessKey: string }): S3ClientConfig`, `normalizeEndpoint(value: string): string` (throws on non-http(s)), `S3MountType` (id `s3`).

- [ ] **Step 1: Write the failing unit test**

`tests/s3-options.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeEndpoint, s3ClientOptions } from "../src/common/s3-options";

describe("S3 options", () => {
  it("normalizes the endpoint", () => {
    expect(normalizeEndpoint("http://127.0.0.1:9000/")).toBe("http://127.0.0.1:9000");
    expect(normalizeEndpoint(" https://s3.example.com ")).toBe("https://s3.example.com");
  });

  it("refuses an endpoint that is not an http(s) URL", () => {
    expect(() => normalizeEndpoint("localhost:9000")).toThrow(/http/);
    expect(() => normalizeEndpoint("ftp://x")).toThrow(/http/);
  });

  it("builds a path-style client config with the vault's credentials", () => {
    const options = s3ClientOptions(
      { endpoint: "http://h:9000/", region: "eu-west-3" },
      { accessKeyId: "AK", secretAccessKey: "SK" },
    );
    expect(options).toEqual({
      endpoint: "http://h:9000",
      region: "eu-west-3",
      forcePathStyle: true,
      credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
    });
    expect(s3ClientOptions({ endpoint: "http://h" }, { accessKeyId: "a", secretAccessKey: "b" }).region).toBe("us-east-1");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @theia-shell/theia-files-s3 exec vitest run tests/s3-options.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/common/s3-options.ts`:
```ts
import type { S3ClientConfig } from "@aws-sdk/client-s3";

export function normalizeEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\/[^/]/.test(trimmed)) throw new Error(`The endpoint must be an http:// or https:// URL, not "${trimmed}".`);
  return trimmed.replace(/\/+$/, "");
}

/** Path-style, so S3-compatible servers (RustFS, MinIO) work as AWS does. */
export function s3ClientOptions(
  config: Record<string, string>,
  secrets: { accessKeyId: string; secretAccessKey: string },
): S3ClientConfig {
  return {
    endpoint: normalizeEndpoint(config.endpoint),
    region: config.region || "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey },
  };
}
```
Replace `src/common/index.ts` with `export * from "./s3-options";`.

`src/browser/s3-mount-type.ts`:
```ts
import { S3Client } from "@aws-sdk/client-s3";
import type { FilesApi } from "@statewalker/webrun-files";
import { S3FilesApi } from "@statewalker/webrun-files-s3";
import { injectable } from "@theia/core/shared/inversify";
import { type MountConfig, type MountContext, type MountField, type MountType, SecretsLocked } from "@theia-shell/theia-files-mounts";
import { s3ClientOptions } from "../common/s3-options";

@injectable()
export class S3MountType implements MountType {
  readonly id = "s3";
  readonly label = "S3 Bucket";
  readonly fields: MountField[] = [
    { name: "endpoint", label: "Endpoint URL", kind: "url", required: true },
    { name: "region", label: "Region", kind: "text", default: "us-east-1" },
    { name: "bucket", label: "Bucket", kind: "text", required: true },
    { name: "prefix", label: "Prefix (optional)", kind: "text" },
    { name: "accessKeyId", label: "Access key ID", kind: "secret", required: true },
    { name: "secretAccessKey", label: "Secret access key", kind: "secret", required: true },
  ];

  isAvailable(): boolean {
    return true;
  }

  async create(mount: MountConfig, ctx: MountContext): Promise<FilesApi> {
    const accessKeyId = await ctx.secret("accessKeyId");
    const secretAccessKey = await ctx.secret("secretAccessKey");
    if (!accessKeyId || !secretAccessKey) {
      throw ctx.locked ? new SecretsLocked() : new Error("The access keys are missing; edit the mount to enter them.");
    }
    const client = new S3Client(s3ClientOptions(mount.config, { accessKeyId, secretAccessKey }));
    const api = new S3FilesApi({ client, bucket: mount.config.bucket, prefix: mount.config.prefix || undefined });
    // Surface bad keys, a missing bucket or CORS now, as the mount's status, not on first use.
    for await (const _ of api.list("/")) break;
    return api;
  }
}
```
`src/browser/s3-frontend-module.ts`:
```ts
import { ContainerModule } from "@theia/core/shared/inversify";
import { MountType } from "@theia-shell/theia-files-mounts";
import { S3MountType } from "./s3-mount-type";

export default new ContainerModule((bind) => {
  bind(S3MountType).toSelf().inSingletonScope();
  bind(MountType).toService(S3MountType);
});
```
`package.json`: add `"@theia-shell/theia-files-mounts": "workspace:*"` to dependencies and
```json
  "theiaExtensions": [
    { "frontend": "lib/browser/s3-frontend-module", "frontendOnly": "lib/browser/s3-frontend-module" }
  ],
```
Add `@theia-shell/theia-files-s3` to `app/package.json` `dependencies` and both build filter lists.

- [ ] **Step 4: Run the unit tests**

Run: `pnpm install && pnpm --filter @theia-shell/theia-files-s3 test && pnpm --filter @theia-shell/theia-files-mounts test`
Expected: all pass (the RustFS one skipped without Docker).

- [ ] **Step 5: Write the S3 e2e test**

`app/tests/s3.spec.ts`:
```ts
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { expect, type Page, test } from "@playwright/test";
// @ts-expect-error — plain JS module
import { hasDocker, startRustFs } from "../../tools/rustfs.mjs";
import { explorer, openMain, readFile, runFromPalette, start, unlockVault } from "./helpers";

test.skip(!hasDocker(), "Docker is not available: the S3 tests need RustFS");

let s3: Awaited<ReturnType<typeof startRustFs>>;
test.beforeAll(async () => {
  s3 = await startRustFs({ port: 19101, origin: "http://127.0.0.1:3100" });
});
test.afterAll(() => s3?.stop());

async function mountS3(page: Page, endpoint: string, keys = { id: s3.accessKeyId, secret: s3.secretAccessKey }) {
  await runFromPalette(page, "Files: Mount File System…");
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "S3 Bucket" }).click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  for (const value of ["Cloud", "cloud", endpoint, "us-east-1", s3.bucket, "", keys.id, keys.secret]) {
    await input.fill(value);
    await page.keyboard.press("Enter");
  }
}

test("an S3 bucket mounts, stores files, and keeps its keys out of settings", async ({ page }) => {
  const errors = await start(page, "", { password: "pw" });
  await mountS3(page, s3.endpoint);
  await expect(explorer(page).getByText("Cloud", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const files = (window as unknown as { theiaShell: { filesApi: { write(p: string, c: Uint8Array[]): Promise<void> } } }).theiaShell.filesApi;
    await files.write("/cloud/hello.md", [new TextEncoder().encode("# from the browser")]);
  });
  const object = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: "hello.md" }));
  expect(await object.Body?.transformToString()).toBe("# from the browser");

  const raw = await page.evaluate(async () => {
    const main = await (await navigator.storage.getDirectory()).getDirectoryHandle("main");
    const shell = await main.getDirectoryHandle(".shell");
    const read = async (dir: FileSystemDirectoryHandle, name: string) => (await (await dir.getFileHandle(name)).getFile()).text();
    return (await read(await shell.getDirectoryHandle("settings"), "settings.json")) + (await read(shell, "secrets.json"));
  });
  expect(raw).not.toContain(s3.secretAccessKey);
  expect(raw).not.toContain(s3.accessKeyId);

  await page.reload();
  await unlockVault(page, "pw");
  await openMain(page);
  await expect(explorer(page).getByText("Cloud", { exact: true })).toBeVisible();
  expect(await readFile(page, "/cloud/hello.md")).toBe("# from the browser");
  expect(errors).toEqual([]);
});

test("with the vault skipped, S3 shows as locked, and Unlock mounts it", async ({ page }) => {
  await start(page, "", { password: "pw" });
  await mountS3(page, s3.endpoint);
  await page.reload();
  await page.locator(".vault-dialog .theia-button.secondary").click(); // Skip
  await openMain(page);
  await expect(explorer(page).getByText("Cloud (locked)", { exact: true })).toBeVisible();
  await runFromPalette(page, "Secrets: Unlock");
  await unlockVault(page, "pw");
  await expect(explorer(page).getByText("Cloud", { exact: true })).toBeVisible();
});

test("an unreachable endpoint shows as unavailable; other mounts work", async ({ page }) => {
  await start(page, "", { password: "pw" });
  await mountS3(page, "http://127.0.0.1:1");
  await expect(explorer(page).getByText(/^Cloud \(unavailable: /)).toBeVisible();
  await expect(explorer(page).getByText("Temporary", { exact: true })).toBeVisible();
});

test("a malformed endpoint is refused in the wizard", async ({ page }) => {
  await start(page, "?storage=memory");
  await runFromPalette(page, "Files: Mount File System…");
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "S3 Bucket" }).click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  for (const value of ["Cloud", "cloud"]) {
    await input.fill(value);
    await page.keyboard.press("Enter");
  }
  await input.fill("localhost:9000");
  await expect(page.locator(".quick-input-message")).toContainText("http://");
});
```

- [ ] **Step 6: Run it red, then green**

Run: `pnpm --filter @theia-shell/app build && pnpm --filter @theia-shell/app exec playwright test tests/s3.spec.ts`
Expected before `s3-frontend-module` is in the app: FAIL (no "S3 Bucket" type). After adding it: 4 passed. If requests fail with a CORS error in the browser console, add the reported header to `S3_BROWSER_HEADERS` in `tools/rustfs.mjs` (and rerun Task 1's test).

- [ ] **Step 7: Commit**

```bash
git add packages/theia-files-s3 packages/theia-files-mounts app pnpm-lock.yaml
git commit -m "theia-shell: S3 mount type, proven against RustFS from the browser

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Documentation and the full check

**Files:**
- Modify: `README.md`, `PLAN.md`, `app/README.md`, `app/files/package.json` (description, done in Task 9), `packages/theia-files-mounts/README.md` (create), `packages/theia-secret-vault/README.md`, `packages/theia-files-s3/README.md`, `packages/theia-files-api/README.md`

- [ ] **Step 1: Write the package README for `theia-files-mounts`**

Sections: what it is; `MountType` and `FilesApiLayer` (the two extension points, with the interfaces copied from `src/common`); the main storage and `/.shell`; the `shell-system:` scheme and why (`UserStorageContribution` hard-codes `file`); preferences `files.mounts` / `files.hidden` with a JSON example; commands; statuses; *Known gaps* (the grep from Task 8 Step 6; workspace-scope settings cannot be written because the root is read-only above the mounts); *Red / green*.

- [ ] **Step 2: Update the app-level docs**

- `README.md`: the layout block lists the three new packages; a short "Mounts and secrets" paragraph linking the spec.
- `PLAN.md`: status line — unit and e2e counts from Step 3; a row "Mounts and vault" pointing at the spec and this plan.
- `app/README.md`: how to run (unchanged), what a first visit shows (the create-password dialog with OPFS; none with `?storage=memory`), how to mount, `files.hidden`, how to run the S3 tests (Docker), test counts, and the red/green log for Tasks 9–10.

- [ ] **Step 3: The full check**

Run (from `apps/theia-shell`):
```bash
pnpm build && pnpm test && pnpm test:e2e
cd ../.. && npx -y @biomejs/biome@2.5.11 check apps/theia-shell
```
Expected: every build clean; every unit test passes; every e2e passes (S3 ones skipped only without Docker); biome clean. Put the exact counts in `PLAN.md` and `app/README.md`.

- [ ] **Step 4: Commit**

```bash
git add README.md PLAN.md app/README.md packages
git commit -m "theia-shell: document mounts, the vault and the S3 type

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
