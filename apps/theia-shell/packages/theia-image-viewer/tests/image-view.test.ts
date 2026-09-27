import { describe, expect, it } from "vitest";
import { fitScale, formatZoom, imageMimeType, stepZoom } from "../src/common/image-view";

describe("imageMimeType", () => {
  it("maps image extensions, case-insensitively", () => {
    expect(imageMimeType("/a/b.png")).toBe("image/png");
    expect(imageMimeType("/a/b.JPG")).toBe("image/jpeg");
    expect(imageMimeType("/a/b.jpeg")).toBe("image/jpeg");
    expect(imageMimeType("/a/b.gif")).toBe("image/gif");
    expect(imageMimeType("/a/b.webp")).toBe("image/webp");
    expect(imageMimeType("/a/b.avif")).toBe("image/avif");
    expect(imageMimeType("/a/b.bmp")).toBe("image/bmp");
    expect(imageMimeType("/a/b.ico")).toBe("image/x-icon");
    expect(imageMimeType("/a/b.svg")).toBe("image/svg+xml");
  });

  it("returns undefined for anything else", () => {
    expect(imageMimeType("/a/b.md")).toBeUndefined();
    expect(imageMimeType("/a/png")).toBeUndefined();
    expect(imageMimeType("/a/b.png.txt")).toBeUndefined();
  });
});

describe("fitScale", () => {
  it("shrinks a large image to fit, keeping its aspect ratio", () => {
    expect(fitScale({ width: 2000, height: 1000 }, { width: 1000, height: 1000 })).toBe(0.5);
    expect(fitScale({ width: 1000, height: 2000 }, { width: 1000, height: 500 })).toBe(0.25);
  });

  it("never enlarges a small image", () => {
    expect(fitScale({ width: 100, height: 50 }, { width: 1000, height: 1000 })).toBe(1);
  });

  it("is 1 for degenerate sizes", () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 1000, height: 1000 })).toBe(1);
    expect(fitScale({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("stepZoom", () => {
  it("moves to the next preset level in either direction", () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.6, 1)).toBe(0.75);
    expect(stepZoom(0.6, -1)).toBe(0.5);
  });

  it("stops at the ends", () => {
    expect(stepZoom(16, 1)).toBe(16);
    expect(stepZoom(0.05, -1)).toBe(0.05);
  });

  it("never moves against the direction, even outside the presets", () => {
    // A huge image fitted to the view is shown below the smallest preset.
    expect(stepZoom(0.02, -1)).toBe(0.02);
    expect(stepZoom(20, 1)).toBe(20);
    expect(stepZoom(0.02, 1)).toBe(0.05);
  });
});

describe("formatZoom", () => {
  it("shows whole percents", () => {
    expect(formatZoom(1)).toBe("100%");
    expect(formatZoom(0.333)).toBe("33%");
  });
});
