import { describe, expect, it } from "vitest";
import { WorkbenchSecretMissingError } from "./errors.js";

describe("WorkbenchSecretMissingError", () => {
  it("is an Error subclass", () => {
    const err = new WorkbenchSecretMissingError("GEMINI_API_KEY");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WorkbenchSecretMissingError);
  });

  it("preserves the secret name on the instance", () => {
    const err = new WorkbenchSecretMissingError("GEMINI_API_KEY");
    expect(err.secretName).toBe("GEMINI_API_KEY");
  });

  it("has a stable name field independent of class minification", () => {
    const err = new WorkbenchSecretMissingError("GEMINI_API_KEY");
    expect(err.name).toBe("WorkbenchSecretMissingError");
  });

  it("includes the secret name in the message", () => {
    const err = new WorkbenchSecretMissingError("GEMINI_API_KEY");
    expect(err.message).toContain("GEMINI_API_KEY");
  });
});
