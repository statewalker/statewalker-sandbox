/**
 * Extension points without slots: an extension point is STATE OF ITS OWNER ACTOR.
 *
 * Contributors send `sys:contribute` / `sys:withdraw` messages to the owner; the owner keeps the
 * contributions, publishes them as one stream (keyed like the point), and watches every contributor
 * so that a stopped contributor's entries vanish. Retention in the other direction — a contributor
 * that activates before the owner — is the contributor's job: it watches the owner and (re)sends its
 * contribution whenever the owner comes up. Both halves are below; together they rebuild what a
 * retained slot gave for free.
 */
import type { ActorContext, Envelope } from "./actors.js";
import { deepEqual, defineStream, type StreamKey } from "./streams.js";

export interface Contribution<C> {
  readonly id: string;
  readonly from: string;
  readonly value: C;
}

/** Declared in API modules: the stream key and the owning address. */
export interface Point<C> {
  readonly key: StreamKey<readonly Contribution<C>[]>;
  readonly owner: string;
}

export const definePoint = <C>(key: string, owner: string): Point<C> => ({
  key: defineStream<readonly Contribution<C>[]>(key),
  owner,
});

export type PointMsg =
  | {
      readonly type: "sys:contribute";
      readonly point: string;
      readonly id: string;
      readonly value: unknown;
    }
  | { readonly type: "sys:withdraw"; readonly point: string; readonly id: string };

const isPointMsg = (msg: unknown): msg is PointMsg =>
  typeof msg === "object" &&
  msg !== null &&
  ((msg as PointMsg).type === "sys:contribute" || (msg as PointMsg).type === "sys:withdraw");

/** Owner side. Call `handle(msg, env)` first in the owner's receive; it returns true if it took it. */
export function ownPoints<M>(
  ctx: ActorContext<M>,
  // biome-ignore lint/suspicious/noExplicitAny: an owner holds points of different contribution types
  points: readonly Point<any>[],
): { handle(msg: unknown, env: Envelope): boolean } {
  const state = new Map<string, Map<string, Contribution<unknown>>>();
  const watched = new Map<string, () => void>();
  for (const p of points) {
    state.set(p.key, new Map());
    ctx.publish(p.key, []);
  }
  const republish = (key: string) => ctx.publish(key, [...(state.get(key)?.values() ?? [])]);

  const dropFrom = (from: string) => {
    watched.get(from)?.();
    watched.delete(from);
    for (const [key, entries] of state) {
      let changed = false;
      for (const [id, c] of entries) {
        if (c.from === from) {
          entries.delete(id);
          changed = true;
        }
      }
      if (changed) republish(key);
    }
  };

  const watchSender = (from: string) => {
    if (watched.has(from)) return;
    let seen = false;
    watched.set(
      from,
      ctx.watch(from, (alive) => {
        if (alive) seen = true;
        else if (seen) dropFrom(from);
      }),
    );
  };

  return {
    handle(msg, env) {
      if (!isPointMsg(msg)) return false;
      const entries = state.get(msg.point);
      if (!entries) {
        ctx.log.error(`"${ctx.self}" owns no extension point "${msg.point}"`);
        return true;
      }
      const from = env.from ?? "outside";
      const existing = entries.get(msg.id);
      if (existing && existing.from !== from) {
        ctx.log.error(
          `"${from}" tried to replace "${msg.id}" in "${msg.point}", owned by "${existing.from}"`,
        );
        return true;
      }
      if (msg.type === "sys:contribute") {
        watchSender(from);
        if (existing && deepEqual(existing.value, msg.value)) return true;
        entries.set(msg.id, { id: msg.id, from, value: msg.value });
      } else if (!entries.delete(msg.id)) {
        return true;
      }
      republish(msg.point);
      return true;
    },
  };
}

export interface Contributed<C> {
  update(value: C): void;
  withdraw(): void;
}

/** Contributor side: keeps `value` registered at `point` for as long as its owner is alive. */
export function contribute<C, M>(
  ctx: ActorContext<M>,
  point: Point<C>,
  id: string,
  value: C,
): Contributed<C> {
  let current = value;
  let ownerUp = false;
  let active = true;
  const send = (msg: PointMsg) => ctx.send<PointMsg>(point.owner, msg);
  const unwatch = ctx.watch(point.owner, (alive) => {
    ownerUp = alive;
    if (alive && active) send({ type: "sys:contribute", point: point.key, id, value: current });
  });
  return {
    update(next) {
      if (!active || deepEqual(current, next)) return;
      current = next;
      if (ownerUp) send({ type: "sys:contribute", point: point.key, id, value: current });
    },
    withdraw() {
      if (!active) return;
      active = false;
      unwatch();
      if (ownerUp) send({ type: "sys:withdraw", point: point.key, id });
    },
  };
}
