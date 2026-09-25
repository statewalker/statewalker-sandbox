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
    const raw =
      (await readText(files, `/.shell/${SECRETS_FILE}`)) +
      (await readText(files, `/.shell/${VAULT_KEY_FILE}`));
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
    await writeText(
      files,
      `/.shell/${SECRETS_FILE}`,
      await readText(other, `/.shell/${SECRETS_FILE}`),
    );
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

  it("keeps both secrets when two saves overlap on one instance", async () => {
    const a = vault();
    await a.create("pw");
    await Promise.all([a.set("a", "1"), a.set("b", "2"), a.delete("none")]);
    const check = vault();
    await check.unlock("pw");
    expect(check.names().sort()).toEqual(["a", "b"]);
  });

  it("reports an unreadable vault.key.json as corrupt, not as a crash", async () => {
    await writeText(files, `/.shell/${VAULT_KEY_FILE}`, "{ not json");
    await expect(vault().unlock("pw")).rejects.toBeInstanceOf(VaultCorruptError);
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
