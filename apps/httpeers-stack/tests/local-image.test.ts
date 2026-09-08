import { describe, expect, it } from "vitest";
import { fileToImage } from "../src/pages/image-peer/local-image.js";
import { imagePath } from "../src/services/images.js";

function fileOf(name: string, type: string, bytes = 64): File {
  return new File([new Uint8Array(bytes).fill(3)], name, { type });
}

describe("fileToImage", () => {
  it("produces bytes keyed as imagePath expects, and metadata that matches them", async () => {
    const { info, bytes, path } = await fileToImage(fileOf("holiday.png", "image/png"));
    expect(path).toBe(imagePath(info.id));
    expect(info.size).toBe(bytes.length);
    expect(info.contentType).toBe("image/png");
  });

  it("uses the file name as the title, because that is what the person recognises", async () => {
    const { info } = await fileToImage(fileOf("cat on a bike.jpg", "image/jpeg"));
    expect(info.title).toContain("cat on a bike");
  });

  it("gives every pick a distinct id, so choosing the same file twice does not collide", async () => {
    const a = await fileToImage(fileOf("same.png", "image/png"));
    const b = await fileToImage(fileOf("same.png", "image/png"));
    expect(a.info.id).not.toBe(b.info.id);
  });

  it("refuses a file that is not an image rather than serving it as one", async () => {
    await expect(fileToImage(fileOf("notes.txt", "text/plain"))).rejects.toThrow(/not an image/i);
  });

  it("falls back to a type when the browser reports none", async () => {
    const { info } = await fileToImage(new File([new Uint8Array(8)], "mystery.png", { type: "" }));
    expect(info.contentType).toMatch(/^image\//);
  });

  // Nothing is re-encoded: peers upgrade to WebRTC and a direct, unlimited
  // connection, so degrading every photograph to guard a fallback that mostly
  // does not happen would throw away the user's bytes for nothing.
  it("serves the bytes exactly as given, without re-encoding", async () => {
    const original = new Uint8Array(4096).map((_, i) => i % 251);
    const { info, bytes } = await fileToImage(
      new File([original], "big.png", { type: "image/png" }),
    );
    expect(bytes).toEqual(original);
    expect(info.size).toBe(original.length);
    expect(info.contentType).toBe("image/png");
  });

});
