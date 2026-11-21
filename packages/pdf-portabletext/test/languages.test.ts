import { describe, expect, it } from "vitest";
import { detectLanguage, letterCount } from "../src/languages.ts";
import { uprightToImage } from "../src/ocr-layout.ts";

describe("language detection", () => {
  const samples: [string, string][] = [
    ["en", "The quick brown fox jumps over the lazy dog and keeps running through the field."],
    ["de", "Die Messungen zeigen eine deutliche Verbesserung gegenüber dem Vorjahr und den Daten."],
    [
      "fr",
      "Portez ce vieux whisky au juge blond qui fume sur son île intérieure, à côté de l'alcôve.",
    ],
    ["nl", "De linzen wassen en in een liter kokend water een dag laten weken met de uien."],
    ["eu", "Euskara Euskal Herriko hizkuntza da eta milaka lagunek hitz egiten dute gaur egun."],
    [
      "ru",
      "Москва является столицей Российской Федерации и крупнейшим городом страны по численности населения.",
    ],
    ["el", "Το γρήγορο καφέ αλεπού πηδά πάνω από τον τεμπέλη σκύλο στο χωράφι κάθε μέρα."],
  ];
  for (const [bcp47, text] of samples) {
    it(`detects ${bcp47}`, () => {
      expect(detectLanguage(text)?.bcp47).toBe(bcp47);
    });
  }

  it("does not guess on short or non-letter text", () => {
    expect(detectLanguage("No vote [note 1]")).toBeUndefined();
    expect(
      detectLanguage("400 + 300 — 12,5 % | 2014/10/04 ... 17 18 19 20 21 22 23"),
    ).toBeUndefined();
  });

  it("counts letters in any script", () => {
    expect(letterCount("Ab 12 Ωж ü!")).toBe(5);
  });
});

describe("uprightToImage", () => {
  // A 100×50 image whose content is turned; the upright frame is 50×100 for 90/270.
  const word = { left: 10, top: 20, right: 30, bottom: 25 };

  it("keeps rects of upright images", () => {
    expect(uprightToImage(word, 0, 100, 50)).toEqual(word);
  });

  it("maps rects back for every rotation and keeps their area", () => {
    for (const rotation of [90, 180, 270]) {
      const r = uprightToImage(
        word,
        rotation,
        rotation === 180 ? 50 : 100,
        rotation === 180 ? 100 : 50,
      );
      expect((r.right - r.left) * (r.bottom - r.top)).toBe(20 * 5);
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
    }
  });

  it("puts the upright top-left corner where a clockwise turn sends it", () => {
    // Content turned 90° clockwise: upright top-left lands at the image's top-right.
    expect(uprightToImage({ left: 0, top: 0, right: 10, bottom: 5 }, 90, 100, 50)).toEqual({
      left: 95,
      top: 0,
      right: 100,
      bottom: 10,
    });
    // 270°: it lands at the bottom-left.
    expect(uprightToImage({ left: 0, top: 0, right: 10, bottom: 5 }, 270, 100, 50)).toEqual({
      left: 0,
      top: 40,
      right: 5,
      bottom: 50,
    });
  });
});
