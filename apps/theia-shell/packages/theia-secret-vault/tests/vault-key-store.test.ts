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
