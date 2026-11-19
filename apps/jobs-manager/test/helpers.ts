import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobMessage } from "../src/types.ts";

export const TASKS_DIR = fileURLToPath(new URL("./fixtures/tasks/", import.meta.url));

export function task(name: string, file: string, cleanup?: string) {
  return {
    name,
    script: join(TASKS_DIR, file),
    ...(cleanup ? { cleanup: join(TASKS_DIR, cleanup) } : {}),
  };
}

export async function tempDir(): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "jobs-test-"));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

export async function collect(gen: AsyncIterable<JobMessage>): Promise<JobMessage[]> {
  const out: JobMessage[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

/** Drops stamps so message sequences can be compared to literals. */
export function shapes(messages: JobMessage[]) {
  return messages.map(({ stamp: _stamp, ...rest }) => rest);
}

export const SCHEMAS_DIR = fileURLToPath(new URL("./fixtures/schemas/", import.meta.url));

export type Image = { width: number; height: number; pixels: Uint8Array };

/** A binary PPM (P6) test image with a pattern, so every pixel is checkable. */
export function makePpm(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixels.set([x % 256, y % 256, (x * y) % 256], (y * width + x) * 3);
  return encodePpm({ width, height, pixels });
}

export function encodePpm({ width, height, pixels }: Image): Uint8Array {
  const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
  const out = new Uint8Array(header.length + pixels.length);
  out.set(header);
  out.set(pixels, header.length);
  return out;
}

/** Parses the PPMs the fixtures write (no comments). */
export function parsePpm(data: Uint8Array): Image {
  const text = new TextDecoder("latin1").decode(data.subarray(0, 64));
  const match = /^P6\n(\d+) (\d+)\n255\n/.exec(text);
  if (!match) throw new Error("not a P6 PPM");
  const [header, w, h] = match as unknown as [string, string, string];
  const width = Number(w);
  const height = Number(h);
  const pixels = data.subarray(header.length);
  if (pixels.length !== width * height * 3) throw new Error("wrong pixel data length");
  return { width, height, pixels };
}

/** The fixtures' nearest-neighbour resize, to check their output byte for byte. */
export function resizeNearest(image: Image, size: number): Image {
  const width = size;
  const height = Math.max(1, Math.round((image.height * size) / image.width));
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor((y * image.height) / height);
    for (let x = 0; x < width; x++) {
      const sx = Math.floor((x * image.width) / width);
      pixels.set(
        image.pixels.subarray((sy * image.width + sx) * 3, (sy * image.width + sx) * 3 + 3),
        (y * width + x) * 3,
      );
    }
  }
  return { width, height, pixels };
}
