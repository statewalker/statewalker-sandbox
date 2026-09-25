import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { mountsSetting, validateMountConfigs } from "../src/common/mount-config";
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
        {
          key: "c",
          name: "C",
          type: "s3",
          config: { endpoint: "http://x", secretAccessKey: "oops" },
        },
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

describe("mountsSetting", () => {
  const defaults = [{ key: "temp", name: "Temporary", type: "memory", config: {} }];

  it("uses the defaults only when the setting is unset", () => {
    expect(mountsSetting(undefined, defaults)).toBe(defaults);
    expect(mountsSetting([], defaults)).toEqual([]);
  });

  it("passes a malformed value on, so it is reported instead of silently replaced", () => {
    const raw = { key: "x" };
    expect(mountsSetting(raw, defaults)).toBe(raw);
    expect(validateMountConfigs(mountsSetting(raw, defaults), types, []).errors).toHaveLength(1);
  });
});
