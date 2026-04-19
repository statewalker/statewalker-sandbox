import { describe, expect, it } from "vitest";
import { getParamsProvider } from "../src/path-params.js";

describe("getParamsProvider", () => {
  it("should extract parameters from matching paths", () => {
    const getPathParams = getParamsProvider("/users/:id");

    const result = getPathParams("/users/123");

    expect(result).toEqual({ id: "123" });
  });

  it("should handle multiple parameters", () => {
    const getPathParams = getParamsProvider("/users/:id/posts/:postId");

    const result = getPathParams("/users/123/posts/456");

    expect(result).toEqual({ id: "123", postId: "456" });
  });

  it("should handle wildcard patterns", () => {
    const getPathParams = getParamsProvider("/static/*");

    const result = getPathParams("/static/css/style.css");

    expect(result).toEqual({ "0": "css/style.css" });
  });

  it("should handle named wildcard patterns", () => {
    const getPathParams = getParamsProvider("/files/:folder/*");

    const result = getPathParams("/files/documents/file.pdf");

    expect(result).toEqual({ folder: "documents", "0": "file.pdf" });
  });

  it("should return null for non-matching paths", () => {
    const getPathParams = getParamsProvider("/users/:id");

    const result = getPathParams("/posts/123");

    expect(result).toBeNull();
  });

  it("should handle paths with no parameters", () => {
    const getPathParams = getParamsProvider("/api/health");

    const result = getPathParams("/api/health");

    expect(result).toEqual({});
  });

  it("should handle paths with query parameters (ignoring them)", () => {
    const getPathParams = getParamsProvider("/users/:id");

    const result = getPathParams("/users/123?active=true&limit=10");

    expect(result).toEqual({ id: "123" });
  });

  it("should handle encoded path parameters", () => {
    const getPathParams = getParamsProvider("/users/:name");

    const result = getPathParams("/users/john%20doe");

    expect(result).toEqual({ name: "john%20doe" });
  });

  it("should be reusable for multiple path extractions", () => {
    const getPathParams = getParamsProvider("/users/:id/posts/:postId");

    const result1 = getPathParams("/users/123/posts/456");
    const result2 = getPathParams("/users/789/posts/101");

    expect(result1).toEqual({ id: "123", postId: "456" });
    expect(result2).toEqual({ id: "789", postId: "101" });
  });

  it("should handle complex nested parameters", () => {
    const getPathParams = getParamsProvider("/api/:version/users/:userId/settings/:settingKey");

    const result = getPathParams("/api/v2/users/123/settings/theme");

    expect(result).toEqual({
      version: "v2",
      userId: "123",
      settingKey: "theme",
    });
  });

  it("should handle root path", () => {
    const getPathParams = getParamsProvider("/");

    const result = getPathParams("/");

    expect(result).toEqual({});
  });

  it("should handle parameter at the end", () => {
    const getPathParams = getParamsProvider("/download/:filename");

    const result = getPathParams("/download/document.pdf");

    expect(result).toEqual({ filename: "document.pdf" });
  });
});
