import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { validateMountForm } from "../src/common/mount-form";
import type { MountType } from "../src/common/mount-types";

const s3: MountType = {
  id: "s3",
  label: "S3 Bucket",
  isAvailable: () => true,
  create: async () => new MemFilesApi(),
  fields: [
    { name: "endpoint", label: "Endpoint URL", kind: "url", required: true },
    { name: "bucket", label: "Bucket", kind: "text", required: true },
    { name: "secretAccessKey", label: "Secret access key", kind: "secret", required: true },
  ],
};
const filled = { endpoint: "http://h:9000", bucket: "b", secretAccessKey: "s" };

describe("validateMountForm", () => {
  it("derives the key from the name until it is edited", () => {
    const r = validateMountForm(
      s3,
      { name: " My Cloud ", key: "", keyEdited: false, fields: filled },
      { taken: ["my-cloud"], editing: false },
    );
    expect(r.key).toBe("my-cloud-2");
    expect(r.valid).toBe(true);
  });

  it("trims an edited key and checks it exactly", () => {
    const r = validateMountForm(
      s3,
      { name: "X", key: " Cloud ", keyEdited: true, fields: filled },
      { taken: ["cloud"], editing: false },
    );
    expect(r.key).toBe("Cloud");
    expect(r.valid).toBe(true);
    const clash = validateMountForm(
      s3,
      { name: "X", key: "cloud", keyEdited: true, fields: filled },
      { taken: ["cloud"], editing: false },
    );
    expect(clash.errors.key).toMatch(/already used/);
  });

  it("requires the name and required fields, and checks URLs", () => {
    const r = validateMountForm(
      s3,
      { name: "", key: "", keyEdited: false, fields: { endpoint: "localhost:9000" } },
      { taken: [], editing: false },
    );
    expect(r.valid).toBe(false);
    expect(r.errors.name).toBeDefined();
    expect(r.errors.fields.endpoint).toMatch(/http/);
    expect(r.errors.fields.bucket).toBeDefined();
    expect(r.errors.fields.secretAccessKey).toBeDefined();
  });

  it("lets a secret stay empty when editing (keep the current value)", () => {
    const r = validateMountForm(
      s3,
      { name: "C", key: "c", keyEdited: true, fields: { endpoint: "http://h", bucket: "b" } },
      { taken: [], editing: true },
    );
    expect(r.valid).toBe(true);
  });
});
