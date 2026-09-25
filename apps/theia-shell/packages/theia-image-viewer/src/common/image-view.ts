const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/** The image MIME type for a path's extension, or undefined if it is not an image. */
export function imageMimeType(path: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? MIME_TYPES[match[1].toLowerCase()] : undefined;
}

export interface Size {
  width: number;
  height: number;
}

/** The scale that fits `image` inside `box`; never above 1 (small images stay 1:1). */
export function fitScale(image: Size, box: Size): number {
  if (image.width <= 0 || image.height <= 0 || box.width <= 0 || box.height <= 0) return 1;
  return Math.min(1, box.width / image.width, box.height / image.height);
}

export const ZOOM_LEVELS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8, 16];

/** The next preset zoom level above (`1`) or below (`-1`) `current`. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const levels = direction > 0 ? ZOOM_LEVELS : [...ZOOM_LEVELS].reverse();
  const next = levels.find((z) => (direction > 0 ? z > current + 1e-9 : z < current - 1e-9));
  return next ?? levels[levels.length - 1];
}

export function formatZoom(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
