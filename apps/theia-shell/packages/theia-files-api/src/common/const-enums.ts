import type {
  FileChangeType,
  FileSystemProviderCapabilities,
} from "@theia/filesystem/lib/common/files";

// Theia declares these as `const enum`s, which exist only for `tsc` inlining:
// nothing is exported at runtime, so an esbuild/vitest build that reads
// `FileChangeType.ADDED` gets `undefined`. The values are fixed by the VS Code
// file-system contract Theia follows; the casts keep them typed as the enums.

export const ChangeType = {
  UPDATED: 0 as FileChangeType.UPDATED,
  ADDED: 1 as FileChangeType.ADDED,
  DELETED: 2 as FileChangeType.DELETED,
} as const;

export const Capabilities = {
  FileReadWrite: 2 as FileSystemProviderCapabilities.FileReadWrite,
  FileFolderCopy: 8 as FileSystemProviderCapabilities.FileFolderCopy,
  PathCaseSensitive: 1024 as FileSystemProviderCapabilities.PathCaseSensitive,
  Readonly: 2048 as FileSystemProviderCapabilities.Readonly,
} as const;
