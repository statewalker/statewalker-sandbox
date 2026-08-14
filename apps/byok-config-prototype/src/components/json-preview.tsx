/**
 * Surfaces the exact bytes that `Save` would write. A prototype whose whole
 * point is a config document has to show the document.
 */
export function JsonPreview({ text }: { text: string }) {
  return (
    <aside className="fixed top-0 right-0 z-30 flex h-full w-[28rem] flex-col border-l bg-card">
      <p className="border-b px-4 py-3 font-semibold text-sm">File contents on save</p>
      <pre className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">{text}</pre>
    </aside>
  );
}
