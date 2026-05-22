import { describe, expect, it } from "vitest";
import { workbenchSessionId } from "./session-id.js";

describe("workbenchSessionId", () => {
  it("formats as workbench/<key>/main", () => {
    expect(workbenchSessionId("repo-foo")).toBe("workbench/repo-foo/main");
  });

  it("sanitises slashes in the workspace key so the id stays well-formed", () => {
    // A workspace key like `parent/child` would corrupt the three-part id;
    // helper must escape or replace.
    const id = workbenchSessionId("parent/child");
    const parts = id.split("/");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("workbench");
    expect(parts[2]).toBe("main");
  });

  it("rejects empty workspace keys", () => {
    expect(() => workbenchSessionId("")).toThrow(/non-empty/i);
  });
});
