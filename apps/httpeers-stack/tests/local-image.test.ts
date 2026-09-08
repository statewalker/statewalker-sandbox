import { describe, expect, it } from "vitest";
import { MAX_IMAGE_DIMENSION, fileToImage } from "../src/pages/image-peer/local-image.js";
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

  // A phone photo is several megabytes. The relay's per-connection data limit
  // is 1 MiB, so a peer that fails its WebRTC upgrade and falls back to the
  // circuit would have the transfer cut off mid-stream.
  it("caps the dimension it will serve", () => {
    expect(MAX_IMAGE_DIMENSION).toBeGreaterThan(0);
    expect(MAX_IMAGE_DIMENSION).toBeLessThanOrEqual(2048);
  });
});
