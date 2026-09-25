export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}
