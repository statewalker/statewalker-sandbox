import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Bash, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { FilesApiAdapter } from "../../src/lib/files-api-adapter.js";

/**
 * Seeds the supplied bashes' filesystems with the same content so we can
 * compare command outputs apples-to-apples.
 */
async function seedBoth(memFs: MemFilesApi, adapterFs: InMemoryFs): Promise<void> {
  // FilesApiAdapter is backed by `memFs`; seed memFs directly via FilesApi.
  await writeText(memFs, "/foo.txt", "hello\n");
  await writeText(memFs, "/a.txt", "first\n");
  await writeText(memFs, "/b.txt", "second\n");
  await memFs.mkdir("/sub");
  await writeText(memFs, "/sub/inside.txt", "nested\n");

  // InMemoryFs (just-bash's own) — seed identically through its writeFile API.
  await adapterFs.writeFile("/foo.txt", "hello\n");
  await adapterFs.writeFile("/a.txt", "first\n");
  await adapterFs.writeFile("/b.txt", "second\n");
  await adapterFs.mkdir("/sub", { recursive: true });
  await adapterFs.writeFile("/sub/inside.txt", "nested\n");
}

function makeBashes() {
  const memFs = new MemFilesApi();
  const adapter = new FilesApiAdapter({ files: memFs });
  const adapterBash = new Bash({ fs: adapter, cwd: "/" });

  const inMemoryFs = new InMemoryFs();
  const referenceBash = new Bash({ fs: inMemoryFs, cwd: "/" });

  return { memFs, inMemoryFs, adapterBash, referenceBash };
}

describe("FilesApiAdapter — parity with just-bash's InMemoryFs", () => {
  describe("Scenario: ls reports the same entries", () => {
    it("`ls /` on both backings yields the same set of names", async () => {
      const { memFs, inMemoryFs, adapterBash, referenceBash } = makeBashes();
      await seedBoth(memFs, inMemoryFs);

      const a = await adapterBash.exec("ls /");
      const b = await referenceBash.exec("ls /");

      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);

      // InMemoryFs auto-creates the POSIX mount points (/bin, /dev, /proc, /usr) for
      // bash's environment. FilesApiAdapter intentionally does NOT — those mounts are
      // bash-runtime concerns, not user data. The parity contract is on the user-data
      // subset; filter the noise out before comparing.
      const POSIX_MOUNTS = new Set(["bin", "dev", "proc", "usr"]);
      const strip = (s: string) =>
        s
          .split(/\s+/)
          .filter(Boolean)
          .filter((n) => !POSIX_MOUNTS.has(n))
          .sort();
      const namesA = strip(a.stdout);
      const namesB = strip(b.stdout);
      expect(namesA).toEqual(namesB);
      expect(namesA).toEqual(["a.txt", "b.txt", "foo.txt", "sub"]);
    });
  });

  describe("Scenario: cat returns the same bytes", () => {
    it("`cat /foo.txt` emits identical stdout", async () => {
      const { memFs, inMemoryFs, adapterBash, referenceBash } = makeBashes();
      await seedBoth(memFs, inMemoryFs);

      const a = await adapterBash.exec("cat /foo.txt");
      const b = await referenceBash.exec("cat /foo.txt");

      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);
      expect(a.stdout).toBe("hello\n");
      expect(a.stdout).toBe(b.stdout);
    });
  });

  describe("Scenario: mkdir + rm behaviour matches", () => {
    it("mkdir -p creates, rm -r removes, on both backings", async () => {
      const { memFs, inMemoryFs, adapterBash, referenceBash } = makeBashes();
      await seedBoth(memFs, inMemoryFs);

      const aMk = await adapterBash.exec("mkdir -p /x/y/z && ls /x/y");
      const bMk = await referenceBash.exec("mkdir -p /x/y/z && ls /x/y");
      expect(aMk.exitCode).toBe(0);
      expect(bMk.exitCode).toBe(0);
      expect(aMk.stdout.trim()).toBe("z");
      expect(bMk.stdout.trim()).toBe("z");

      const aRm = await adapterBash.exec("rm -r /x && (test -d /x; echo $?)");
      const bRm = await referenceBash.exec("rm -r /x && (test -d /x; echo $?)");
      expect(aRm.exitCode).toBe(0);
      expect(bRm.exitCode).toBe(0);
      // After removal, `test -d /x` exits non-zero (1), printed by `echo $?`.
      expect(aRm.stdout.trim()).toBe("1");
      expect(bRm.stdout.trim()).toBe("1");
    });
  });

  describe("Scenario: appendFile preserves binary content", () => {
    it("appending text to a file containing non-UTF-8 bytes does not corrupt the original bytes", async () => {
      const memFs = new MemFilesApi();
      // Bytes 0x80..0x83 are a stand-alone continuation sequence — invalid as
      // UTF-8. A read-as-text/write-as-text round-trip would replace them with
      // U+FFFD and destroy the file.
      const binary = new Uint8Array([0x80, 0x81, 0x82, 0x83]);
      await memFs.write("/bin.dat", [binary]);

      const adapter = new FilesApiAdapter({ files: memFs, cwd: "/" });
      await adapter.appendFile("/bin.dat", "X");

      const after = await adapter.readFileBuffer("/bin.dat");
      expect(Array.from(after)).toEqual([0x80, 0x81, 0x82, 0x83, 0x58]); // "X" === 0x58
    });
  });

  describe("Scenario: missing-file read produces an error", () => {
    it("`cat /does-not-exist.txt` exits non-zero with an ENOENT-shaped message", async () => {
      const { memFs, inMemoryFs, adapterBash } = makeBashes();
      await seedBoth(memFs, inMemoryFs);

      const r = await adapterBash.exec("cat /does-not-exist.txt");
      expect(r.exitCode).not.toBe(0);
      // Bash's `cat` produces a message containing the path; the adapter's
      // ENOENT error surfaces somewhere in the stderr text.
      const combined = `${r.stderr}\n${r.stdout}`.toLowerCase();
      expect(combined).toMatch(/no such file|does-not-exist/);
    });
  });
});
