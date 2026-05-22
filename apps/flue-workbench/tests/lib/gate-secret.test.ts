import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFilesViews } from "../../src/lib/build-files-views.js";
import { WorkbenchSecretMissingError } from "../../src/lib/errors.js";
import { FilesApiSecretStore } from "../../src/lib/files-api-secret-store.js";
import { gateSecret } from "../../src/lib/gate-secret.js";

describe("gateSecret", () => {
  let rootFiles: MemFilesApi;
  let secrets: FilesApiSecretStore;

  beforeEach(() => {
    rootFiles = new MemFilesApi();
    const { systemFiles } = buildFilesViews(rootFiles);
    secrets = new FilesApiSecretStore({ systemFiles });
  });

  describe("Scenario: existing key proceeds without prompt", () => {
    it("returns the existing value without calling onSecretRequest", async () => {
      await secrets.set("GEMINI_API_KEY", "AIza-existing");
      const onSecretRequest = vi.fn();
      const value = await gateSecret(secrets, "GEMINI_API_KEY", onSecretRequest);
      expect(value).toBe("AIza-existing");
      expect(onSecretRequest).not.toHaveBeenCalled();
    });
  });

  describe("Scenario: missing key prompts and persists", () => {
    it("calls onSecretRequest, persists the result, returns the value", async () => {
      const onSecretRequest = vi.fn().mockResolvedValue("AIza-from-modal");
      const value = await gateSecret(secrets, "GEMINI_API_KEY", onSecretRequest);
      expect(value).toBe("AIza-from-modal");
      expect(onSecretRequest).toHaveBeenCalledWith("GEMINI_API_KEY");
      expect(await secrets.get("GEMINI_API_KEY")).toBe("AIza-from-modal");
    });

    it("rejects empty strings just like dismissed prompts", async () => {
      const onSecretRequest = vi.fn().mockResolvedValue("");
      await expect(gateSecret(secrets, "GEMINI_API_KEY", onSecretRequest)).rejects.toBeInstanceOf(
        WorkbenchSecretMissingError,
      );
      // Nothing persisted.
      expect(await secrets.get("GEMINI_API_KEY")).toBeUndefined();
    });
  });

  describe("Scenario: dismissed prompt rejects atomically", () => {
    it("propagates as WorkbenchSecretMissingError and persists nothing", async () => {
      const onSecretRequest = vi.fn().mockRejectedValue(new Error("user cancelled"));
      await expect(gateSecret(secrets, "GEMINI_API_KEY", onSecretRequest)).rejects.toBeInstanceOf(
        WorkbenchSecretMissingError,
      );
      expect(await secrets.get("GEMINI_API_KEY")).toBeUndefined();
    });

    it("the rejected error carries the secret name for instanceof handlers", async () => {
      const onSecretRequest = vi.fn().mockRejectedValue(new Error("dismissed"));
      try {
        await gateSecret(secrets, "GEMINI_API_KEY", onSecretRequest);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkbenchSecretMissingError);
        expect((err as WorkbenchSecretMissingError).secretName).toBe("GEMINI_API_KEY");
      }
    });
  });
});
