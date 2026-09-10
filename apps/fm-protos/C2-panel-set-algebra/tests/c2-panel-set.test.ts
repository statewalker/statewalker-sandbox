import { describe, expect, it } from "vitest";
import { PanelsModel, expectReplacedNotMutated } from "@fm/app";

/** C2 — two orders over one id set, plus slots and naming. */

const build = (slots = ["left", "right"]) => new PanelsModel({ slots });

const add = (panels: PanelsModel, n: number) =>
  Array.from({ length: n }, (_, i) => panels.add({ storage: "mem://a", path: `/p${i}` }).id);

describe("C2 · ring and MRU are two orders over one set", () => {
  it("keeps identical id sets at all times", () => {
    const panels = build(["a", "b", "c", "d"]);
    const ids = add(panels, 4);
    expect([...panels.order].sort()).toEqual([...panels.mru].sort());
    expect([...panels.order].sort()).toEqual([...ids].sort());
  });

  it("Tab walks the STABLE ring, so activation does not strand panels", () => {
    const panels = build(["a", "b", "c", "d"]);
    const [p1, p2, p3, p4] = add(panels, 4);
    panels.activate(p3);
    panels.activate(p1); // activation churn must not reorder the ring
    expect(panels.order).toEqual([p1, p2, p3, p4]);

    const walked = [panels.activeId];
    for (let i = 0; i < 3; i++) walked.push(panels.next());
    expect(walked.sort()).toEqual([p1, p2, p3, p4].sort()); // every panel reachable
  });

  it("wraps in both directions", () => {
    const panels = build(["a", "b", "c"]);
    const [p1, , p3] = add(panels, 3);
    panels.activate(p1);
    expect(panels.previous()).toBe(p3);
    expect(panels.next()).toBe(p1);
  });

  it("mru[0] is always the active panel", () => {
    const panels = build(["a", "b", "c"]);
    const ids = add(panels, 3);
    for (const id of [ids[2], ids[0], ids[1]]) {
      panels.activate(id);
      expect(panels.mru[0]).toBe(panels.activeId);
      expect(panels.activeId).toBe(id);
    }
  });
});

describe("C2 · the operation target", () => {
  it("is implicit with two panels — no picker", () => {
    const panels = build();
    const [p1, p2] = add(panels, 2);
    panels.activate(p1);
    expect(panels.targetFor(p1)).toEqual({ id: p2, needsPicker: false });
  });

  it("is mru[1] with three or more, and the picker is offered in MRU order", () => {
    const panels = build(["a", "b", "c"]);
    const [p1, p2, p3] = add(panels, 3);
    panels.activate(p3);
    panels.activate(p2);
    panels.activate(p1); // mru: p1, p2, p3
    const target = panels.targetFor(p1);
    expect(target).toEqual({ id: p2, needsPicker: true });
    expect(panels.pickerOrder(p1)).toEqual([p2, p3]);
  });

  it("has no target when only one panel exists", () => {
    const panels = build();
    const [p1] = add(panels, 1);
    expect(panels.targetFor(p1)).toBeUndefined();
  });
});

describe("C2 · removal (head, middle and tail of the ring)", () => {
  const cases: [string, number][] = [["head", 0], ["middle", 1], ["tail", 2]];

  for (const [where, index] of cases) {
    it(`keeps both orders consistent when removing at the ${where}`, () => {
      const panels = build(["a", "b", "c", "d"]);
      const ids = add(panels, 4);
      panels.remove(ids[index]);
      expect(panels.order).not.toContain(ids[index]);
      expect(panels.mru).not.toContain(ids[index]);
      expect([...panels.order].sort()).toEqual([...panels.mru].sort());
      expect(panels.order.length).toBe(3);
    });
  }

  it("promotes mru[1] when the active panel is removed", () => {
    const panels = build(["a", "b", "c"]);
    const [p1, p2, p3] = add(panels, 3);
    panels.activate(p3);
    panels.activate(p2);
    panels.activate(p1);
    panels.remove(p1);
    expect(panels.activeId).toBe(p2);
  });

  it("leaves no active panel — and does not throw — when the last one goes", () => {
    const panels = build();
    const [p1] = add(panels, 1);
    panels.remove(p1);
    expect(panels.activeId).toBeUndefined();
    expect(panels.order).toEqual([]);
    expect(() => panels.next()).not.toThrow();
    expect(panels.next()).toBeUndefined();
    expect(panels.canOperate()).toBe(false);
  });

  it("frees the slot for reuse", () => {
    const panels = build();
    const [p1] = add(panels, 2);
    expect(panels.get(p1).slot).toBe("left");
    panels.remove(p1);
    const revived = panels.add({ storage: "mem://a", path: "/x" });
    expect(revived.slot).toBe("left");
  });
});

describe("C2 · slots", () => {
  it("defaults to the first free slot", () => {
    const panels = build(["left", "right", "aux-1"]);
    expect(add(panels, 3).map((id) => panels.get(id).slot)).toEqual(["left", "right", "aux-1"]);
  });

  it("honours an explicit slot request", () => {
    const panels = build(["left", "right", "aux-1"]);
    const panel = panels.add({ storage: "mem://a", path: "/x", slot: "aux-1" });
    expect(panel.slot).toBe("aux-1");
  });

  it("declines gracefully when the layout is full, rather than throwing", () => {
    const panels = build(["left"]);
    add(panels, 1);
    const overflow = panels.add({ storage: "mem://a", path: "/y" });
    expect(overflow.slot).toBeUndefined(); // floating; the view layer decides
    expect(panels.order.length).toBe(2);
  });

  it("inserts a new panel after the active one in the ring", () => {
    const panels = build(["a", "b", "c"]);
    const [p1, p2] = add(panels, 2);
    panels.activate(p1);
    const p3 = panels.add({ storage: "mem://a", path: "/z" }).id;
    expect(panels.order).toEqual([p1, p3, p2]);
  });
});

describe("C2 · naming", () => {
  it("uses the last path segment", () => {
    const panels = build();
    expect(panels.add({ storage: "mem://a", path: "/home/Documents" }).name).toBe("Documents");
  });

  it("falls back to a letter at the root", () => {
    const panels = build();
    expect(panels.add({ storage: "mem://a", path: "/" }).name).toBe("A");
    expect(panels.add({ storage: "mem://a", path: "/" }).name).toBe("B");
  });

  it("disambiguates deterministically", () => {
    const panels = build(["a", "b", "c"]);
    const names = ["/x/Documents", "/y/Documents", "/z/Documents"].map(
      (path) => panels.add({ storage: "mem://a", path }).name,
    );
    expect(names).toEqual(["Documents", "Documents (2)", "Documents (3)"]);
  });

  it("does not renumber survivors when a duplicate is removed", () => {
    const panels = build(["a", "b", "c"]);
    const first = panels.add({ storage: "mem://a", path: "/x/Docs" });
    const second = panels.add({ storage: "mem://a", path: "/y/Docs" });
    panels.remove(first.id);
    // Renaming a panel the user is looking at, to tidy up numbering, is worse
    // than a gap in the sequence.
    expect(panels.get(second.id).name).toBe("Docs (2)");
  });
});

describe("C2 · model discipline", () => {
  it("replaces the ring rather than mutating it", async () => {
    const panels = build(["a", "b", "c"]);
    add(panels, 2);
    await expectReplacedNotMutated(panels, () => panels.order, () => {
      panels.add({ storage: "mem://a", path: "/new" });
    });
  });

  it("replaces the MRU stack rather than mutating it", async () => {
    const panels = build(["a", "b", "c"]);
    const ids = add(panels, 3);
    // ids[2] is already active after add(), and activate() is idempotent by
    // design — so the write must target a panel that is NOT active.
    await expectReplacedNotMutated(panels, () => panels.mru, () => panels.activate(ids[0]));
  });
});

describe("C2 · property tests over random sequences", () => {
  const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`holds every invariant for seed ${seed}`, () => {
      const random = rng(seed);
      const panels = build(Array.from({ length: 6 }, (_, i) => `s${i}`));
      for (let step = 0; step < 200; step++) {
        const roll = random();
        if (roll < 0.45 || panels.order.length === 0) {
          panels.add({ storage: "mem://a", path: `/p${step}` });
        } else if (roll < 0.75) {
          panels.activate(panels.order[Math.floor(random() * panels.order.length)]);
        } else {
          panels.remove(panels.order[Math.floor(random() * panels.order.length)]);
        }

        expect([...panels.order].sort()).toEqual([...panels.mru].sort());
        expect(new Set(panels.order).size).toBe(panels.order.length);
        if (panels.order.length > 0) {
          expect(panels.mru[0]).toBe(panels.activeId);
          expect(panels.order).toContain(panels.activeId);
          const walked = new Set([panels.activeId]);
          for (let i = 1; i < panels.order.length; i++) walked.add(panels.next());
          expect(walked.size).toBe(panels.order.length);
        } else {
          expect(panels.activeId).toBeUndefined();
        }
        const slots = panels.order.map((id) => panels.get(id).slot).filter(Boolean);
        expect(new Set(slots).size).toBe(slots.length); // no slot held twice
      }
    });
  }
});
