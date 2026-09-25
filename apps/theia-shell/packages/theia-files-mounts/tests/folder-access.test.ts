import { describe, expect, it } from "vitest";
import { ensureFolderAccess, type PermissionHandle } from "../src/common/folder-access";
import { NeedsUserGesture } from "../src/common/mount-types";

function handle(
  query: PermissionState,
  request: PermissionState = query,
): PermissionHandle & { requested: number } {
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
    await expect(ensureFolderAccess(handle("prompt"), false, yes)).rejects.toBeInstanceOf(
      NeedsUserGesture,
    );
  });

  it("asks from a gesture, and passes when granted", async () => {
    const h = handle("prompt", "granted");
    await ensureFolderAccess(h, true, yes);
    expect(h.requested).toBe(1);
  });

  it("fails when the user denies it", async () => {
    await expect(ensureFolderAccess(handle("prompt", "denied"), true, yes)).rejects.toThrow(
      /not granted/,
    );
  });

  it("fails when the folder is gone", async () => {
    await expect(ensureFolderAccess(handle("granted"), false, async () => false)).rejects.toThrow(
      /gone/,
    );
  });
});
