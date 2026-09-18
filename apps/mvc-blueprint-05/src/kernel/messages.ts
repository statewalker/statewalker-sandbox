import type { Msg } from "./store.ts";

declare const matched: unique symbol;
/**
 * What `match` narrows to. The brand exists only in types: without it a payload-less message
 * would narrow to plain `Msg`, and the false branch of `if (x.match(msg))` would become `never`.
 */
export type Matched<P> = Msg & Readonly<P> & { readonly [matched]: true };

/** A message declaration: a creator that also knows its type and narrows. */
export interface MsgDef<P extends object> {
  readonly type: string;
  (...payload: keyof P extends never ? [] : [P]): Msg & Readonly<P>;
  match(msg: Msg): msg is Matched<P>;
}

// biome-ignore lint/complexity/noBannedTypes: `{}` is the "no payload" case.
export function defineMsg<P extends object = {}>(type: string): MsgDef<P> {
  const create = (...payload: [P?]) => ({ ...(payload[0] ?? {}), type }) as Msg & Readonly<P>;
  return Object.assign(create, {
    type,
    match: (msg: Msg): msg is Matched<P> => msg.type === type,
  }) as MsgDef<P>;
}
