import { BaseClass } from "@statewalker/shared-baseclass";
import { describe, expect, it } from "vitest";
import { expectCoalescedEdge, expectNoSelfWake, expectReplacedNotMutated } from "@todo/app";

/** A stand-in obeying §4.8: fields are private to the class, writes are mutators. */
class Input extends BaseClass {
  /** Level. */ draft = "";
  /** State-latest edge. */ refreshCount = 0;
  setDraft(v: string) { this.draft = v; this.notify(); }
  requestRefresh() { this.refreshCount++; this.notify(); }
}
class Outer extends BaseClass {
  items: string[] = [];
  readonly input = new Input();
  addItem(x: string) { this.items = [...this.items, x]; this.notify(); }
  mutateInPlace(x: string) { this.items.push(x); this.notify(); }
}

describe("B1 · model kit", () => {
  describe("expectNoSelfWake", () => {
    it("passes a controller subscribed to input", async () => {
      const outer = new Outer();
      let reactions = 0;
      outer.input.onUpdate(() => { reactions++; });
      await expectNoSelfWake({
        reactions: () => reactions,
        writeOuter: () => outer.addItem("x"),
        writeInput: () => outer.input.setDraft("q"),
      });
    });

    it("REJECTS a controller subscribed to the outer model — it would loop", async () => {
      const outer = new Outer();
      let reactions = 0;
      outer.onUpdate(() => { reactions++; });
      await expect(
        expectNoSelfWake({
          reactions: () => reactions,
          writeOuter: () => outer.addItem("x"),
          writeInput: () => outer.input.setDraft("q"),
        }),
      ).rejects.toThrow(/reacted to its own write/);
    });

    it("REJECTS a controller subscribed to nothing — absence of wiring is not the rule", async () => {
      // fm-protos' version passes here, because it never touches `input`.
      const outer = new Outer();
      await expect(
        expectNoSelfWake({
          reactions: () => 0,
          writeOuter: () => outer.addItem("x"),
          writeInput: () => outer.input.setDraft("q"),
        }),
      ).rejects.toThrow(/never reacted to `input`/);
    });
  });

  describe("expectCoalescedEdge", () => {
    const wire = (act: (input: Input, handled: { n: number }, hit: () => void) => void) => {
      const input = new Input();
      const handled = { n: 0 };
      let actions = 0;
      input.onUpdate(() => act(input, handled, () => { actions++; }));
      return { input, actions: () => actions };
    };

    it("passes when N bumps in one tick produce ONE action", () => {
      let actions = 0;
      let handled = 0;
      const input = new Input();
      // Defer, as a real controller does: it awaits the store before acting.
      let scheduled = false;
      input.onUpdate(() => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => { scheduled = false; });
        if (input.refreshCount > handled) { handled = input.refreshCount; actions++; }
      });
      expectCoalescedEdge({
        bump: () => input.requestRefresh(),
        read: () => input.refreshCount,
        actions: () => actions,
        label: "refreshCount",
      });
      void wire;
    });

    it("REJECTS a controller that acts once per bump", () => {
      const input = new Input();
      let actions = 0;
      let last = 0;
      input.onUpdate(() => { while (last < input.refreshCount) { last++; actions++; } });
      expect(() =>
        expectCoalescedEdge({
          bump: () => input.requestRefresh(),
          read: () => input.refreshCount,
          actions: () => actions,
          label: "refreshCount",
        }),
      ).toThrow(/coalesce/);
    });

    it("REJECTS a controller that never acts", () => {
      const input = new Input();
      expect(() =>
        expectCoalescedEdge({
          bump: () => input.requestRefresh(),
          read: () => input.refreshCount,
          actions: () => 0,
          label: "refreshCount",
        }),
      ).toThrow(/never acted/);
    });

    it("REJECTS a mutator that does not actually raise the counter", () => {
      const input = new Input();
      expect(() =>
        expectCoalescedEdge({
          bump: () => input.setDraft("x"),
          read: () => input.refreshCount,
          actions: () => 1,
          label: "refreshCount",
        }),
      ).toThrow(/must raise a monotonic counter/);
    });
  });

  describe("expectReplacedNotMutated", () => {
    it("REJECTS an in-place push", async () => {
      const outer = new Outer();
      await expect(
        expectReplacedNotMutated(outer, () => outer.items, () => outer.mutateInPlace("x")),
      ).rejects.toThrow(/replaced/);
    });
  });
});
