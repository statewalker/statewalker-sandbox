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
    // A leading dot is reserved for system mounts (never a root, so never reachable).
    expect(validateKey(".data", [])).toMatch(/\./);
    // Characters that change a URI's meaning would give a dead root.
    for (const key of ["notes#1", "a?b", "50%", "a\\b"]) expect(validateKey(key, [])).toBeDefined();
    expect(validateKey("my-disk", ["cloud"])).toBeUndefined();
  });
});
