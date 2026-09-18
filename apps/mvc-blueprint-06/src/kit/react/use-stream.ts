import { useCallback, useSyncExternalStore } from "react";
import type { StreamKey, StreamReader } from "../../kernel/index.js";

/** The React binding: a stream read through useSyncExternalStore. */
export function useStream<S>(reader: StreamReader, key: StreamKey<S> | string): S | undefined {
  const subscribe = useCallback((cb: () => void) => reader.subscribe(key, cb), [reader, key]);
  const get = useCallback(() => reader.get(key) as S | undefined, [reader, key]);
  return useSyncExternalStore(subscribe, get, get);
}
