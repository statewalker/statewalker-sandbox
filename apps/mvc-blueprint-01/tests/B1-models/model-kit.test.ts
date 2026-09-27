import { expectCoalescedEdge, expectNoSelfWake, expectReplacedNotMutated } from "@todo/app";
import { effect, signal, untracked } from "@todo/signals";
import { describe, expect, it } from "vitest";

/** A stand-in with the model's shape: signals in a closure, mutators to write them. */
const standIn = () => {
  const draft = signal("");
  const refreshCount = signal(0);
  const items = signal<string[]>([]);
  return {
    draft: () => draft(),
    refreshCount: () => refreshCount(),
    items: () => items(),
    setDraft: (v: string) => draft(v),
    requestRefresh: () => refreshCount(untracked(() => refreshCount()) + 1),
    addItem: (x: string) => items([...untracked(() => items()), x]),
    /** The mistake: the array changes, the signal never hears of it. */
    mutateInPlace: (x: string) => {
      untracked(() => items()).push(x);
    },
  };
};

describe("B1 · model kit", () => {
  describe("expectNoSelfWake", () => {
    it("passes a controller whose effect reads only the input", async () => {
      const m = standIn();
      let reactions = 0;
      effect(() => {
        m.draft();
        m.refreshCount();
        reactions++;
      });
      await expectNoSelfWake({
        reactions: () => reactions,
        writeOuter: () => m.addItem("x"),
        writeInput: () => m.setDraft("q"),
      });
    });

    it("REJECTS a controller whose effect reads what it writes — it would loop", async () => {
      const m = standIn();
      let reactions = 0;
      effect(() => {
        m.items();
        reactions++;
      });
      await expect(
        expectNoSelfWake({
          reactions: () => reactions,
          writeOuter: () => m.addItem("x"),
          writeInput: () => m.setDraft("q"),
        }),
      ).rejects.toThrow(/reacted to its own write/);
    });

    it("REJECTS a controller subscribed to nothing — absence of wiring is not the rule", async () => {
      const m = standIn();
      await expect(
        expectNoSelfWake({
          reactions: () => 0,
          writeOuter: () => m.addItem("x"),
          writeInput: () => m.setDraft("q"),
        }),
      ).rejects.toThrow(/never reacted to `input`/);
    });
  });

  describe("expectCoalescedEdge", () => {
    it("passes when N bumps in one tick produce ONE action", () => {
      const m = standIn();
      let actions = 0;
      let handled = 0;
      let scheduled = false;
      let first = true;
      // Defer, as a real controller does: it awaits the store before acting.
      effect(() => {
        const n = m.refreshCount();
        if (first) {
          first = false;
          return;
        }
        untracked(() => {
          if (scheduled) return;
          scheduled = true;
          queueMicrotask(() => {
            scheduled = false;
          });
          if (n > handled) {
            handled = n;
            actions++;
          }
        });
      });
      expectCoalescedEdge({
        bump: () => m.requestRefresh(),
        read: () => m.refreshCount(),
        actions: () => actions,
        label: "refreshCount",
      });
    });

    it("REJECTS a controller that acts once per bump", () => {
      const m = standIn();
      let actions = 0;
      let last = 0;
      effect(() => {
        const n = m.refreshCount();
        untracked(() => {
          while (last < n) {
            last++;
            actions++;
          }
        });
      });
      expect(() =>
        expectCoalescedEdge({
          bump: () => m.requestRefresh(),
          read: () => m.refreshCount(),
          actions: () => actions,
          label: "refreshCount",
        }),
      ).toThrow(/coalesce/);
    });

    it("REJECTS a controller that never acts", () => {
      const m = standIn();
      expect(() =>
        expectCoalescedEdge({
          bump: () => m.requestRefresh(),
          read: () => m.refreshCount(),
          actions: () => 0,
          label: "refreshCount",
        }),
      ).toThrow(/never acted/);
    });

    it("REJECTS a mutator that does not actually raise the counter", () => {
      const m = standIn();
      expect(() =>
        expectCoalescedEdge({
          bump: () => m.setDraft("x"),
          read: () => m.refreshCount(),
          actions: () => 1,
          label: "refreshCount",
        }),
      ).toThrow(/must raise a monotonic counter/);
    });
  });

  describe("expectReplacedNotMutated", () => {
    it("passes a proper replacement", async () => {
      const m = standIn();
      await expectReplacedNotMutated(m.items, () => m.addItem("x"));
    });

    it("REJECTS an in-place push — the signal never hears of it", async () => {
      // The parent also rejected "a replacement that forgot to notify". Under
      // signals that mistake cannot be made: writing a new value IS the notify.
      const m = standIn();
      await expect(expectReplacedNotMutated(m.items, () => m.mutateInPlace("x"))).rejects.toThrow(
        /replaced/,
      );
    });
  });
});
