import { describe, expect, it } from "vitest";
import { formatDate, formatSize, pluralCategory } from "../src/common/format";
import { currentLocale } from "../src/common/locale";

describe("currentLocale", () => {
  it("falls back to en outside a browser", () => {
    expect(currentLocale()).toBe("en");
  });
});

describe("formatSize", () => {
  it("picks the largest unit below 1024 and localizes number and unit", () => {
    expect(formatSize(0, "en")).toBe("0 byte");
    expect(formatSize(512, "en")).toBe("512 byte");
    expect(formatSize(1536, "en")).toBe("1.5 kB");
    expect(formatSize(1536, "de")).toBe("1,5 kB");
    expect(formatSize(5 * 1024 ** 2, "en")).toBe("5 MB");
    expect(formatSize(3.25 * 1024 ** 3, "en")).toBe("3.3 GB");
  });
});

describe("formatDate", () => {
  it("formats in the given locale", () => {
    const t = Date.UTC(2026, 8, 26, 12, 0);
    expect(formatDate(t, "en")).toMatch(/26/);
    expect(formatDate(t, "de")).toMatch(/26\.09\.26|26\.9\.26|26\.09\.2026/);
  });
});

describe("pluralCategory", () => {
  it("follows CLDR rules per locale", () => {
    expect(pluralCategory(1, "en")).toBe("one");
    expect(pluralCategory(2, "en")).toBe("other");
    expect(pluralCategory(3, "ru")).toBe("few");
    expect(pluralCategory(5, "ru")).toBe("many");
    expect(pluralCategory(21, "ru")).toBe("one");
  });
});
