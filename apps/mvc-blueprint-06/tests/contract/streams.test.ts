import { StreamHub, shallowEqual } from "../../src/kernel/index.js";
import { type StreamUnderTest, streamContract } from "./stream-contract.js";

streamContract("StreamHub (the kernel's)", () => {
  const errors: unknown[] = [];
  const hub = new StreamHub((_k, e) => errors.push(e));
  return {
    errors,
    get: () => hub.get<{ a: number }>("k"),
    subscribe: (l) => hub.subscribe("k", l),
    publish: (v) => hub.publish("k", "owner", v),
    release: () => hub.release("k", "owner"),
  };
});

/** A second, hand-rolled implementation: an array of listeners and nothing else. */
function handRolled<S>(): StreamUnderTest<S> {
  let value: S | undefined;
  let listeners: { l: () => void; live: boolean }[] = [];
  const errors: unknown[] = [];
  const notify = () => {
    for (const x of listeners.slice()) {
      if (!x.live) continue;
      try {
        x.l();
      } catch (e) {
        errors.push(e);
      }
    }
  };
  return {
    errors,
    get: () => value,
    subscribe(l) {
      const x = { l, live: true };
      listeners.push(x);
      try {
        l();
      } catch (e) {
        errors.push(e);
      }
      return () => {
        x.live = false;
        listeners = listeners.filter((y) => y !== x);
      };
    },
    publish(v) {
      if (shallowEqual(value, v)) return;
      value = v;
      notify();
    },
    release() {
      if (value === undefined) return;
      value = undefined;
      notify();
    },
  };
}

streamContract("hand-rolled", handRolled);
