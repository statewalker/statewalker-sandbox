// KNOWN HOLES, MADE EXECUTABLE. Added 2026-09-10 by the Track SH audit.
//
// `lib/ORIGIN.md` records two holes under "Known holes", and the work order
// for this track is explicit that they must be "carried forward as failing or
// explicitly-pending tests rather than silently inherited". They were
// inherited: before this file they existed only as prose — `lib/ORIGIN.md`,
// `03-a2ui-binding/README.md`'s "Not covered" list, `PROVENANCE.md` defect 5,
// and one `KNOWN HOLE:` comment at `lib/renderer.ts:158` — with no test of
// any kind. A 301-test green run said nothing about either.
//
// NEITHER IS FIXED HERE, deliberately. They are design gaps with real
// trade-offs (see each block), not defects to close in a restoration unit.
// What changes is that they are now pinned by assertions describing the
// CURRENT behaviour, in the house style `PROVENANCE.md` uses for `lib/`
// defects: each test turns RED when the hole is closed, so a fix cannot land
// silently and cannot be forgotten either.
//
// DERIVED-FROM-NOTE: lib/ORIGIN.md "Known holes" (1st and 2nd entries)
// DERIVED-FROM-NOTE: 22-Prototype 3: Data Binding and Action Dispatch
// DERIVED-FROM-NOTE: 24-Prototypes 2, 3 and 8 API Reference §"Reconciliation contract"

import { beforeEach, describe, expect, it } from "vitest";
import { type Catalog, type ComponentDef, shellCatalog } from "../../lib/catalog.js";
import { type A2uiMessage, createRenderer } from "../../lib/renderer.js";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

const CATALOG_ID = "https://httpeers.dev/catalogs/shell/v1/catalog.json";

const create: A2uiMessage = {
  version: "v0.9.1",
  createSurface: { surfaceId: "dialog", catalogId: CATALOG_ID },
};

describe("HOLE 1 — a binding bypasses enum validation", () => {
  /**
   * `lib/renderer.ts:156-159`:
   *
   *   "A binding may stand in for any scalar property, so enum and type
   *   checks are skipped for path references — the value is not known until
   *   render time. KNOWN HOLE: a binding may resolve to a value the
   *   catalogue forbids."
   *
   * Why it is not closed here: the fix is a design choice between
   * resolve-then-validate at render time (which makes a data update able to
   * throw, on a boundary that currently cannot) and accepting the hole
   * explicitly. `03-a2ui-binding/README.md` says so and leaves it open.
   *
   * Why it matters more than the prose suggests: the catalogue is the ONLY
   * gate on a surface authored by a foreign peer (rung 09). A gate with a
   * documented bypass is the security-relevant half of this rung.
   */

  it("rejects a forbidden literal and accepts the identical value through a binding", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);

    // The gate, working, when the value is a literal.
    expect(() =>
      r.handle({
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "dialog",
          components: [{ id: "root", component: "Text", text: "hi", variant: "h7" }],
        },
      }),
    ).toThrow(/must be one of/);

    // The same forbidden value, arriving by binding: accepted, rendered.
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Text", text: "hi", variant: { path: "/v" } },
        ],
      },
    });
    r.handle({
      version: "v0.9.1",
      updateDataModel: { surfaceId: "dialog", path: "/v", value: "h7" },
    });

    // PINS THE HOLE. No throw, and the catalogue's enum is not consulted.
    // Goes red when resolve-then-validate lands, which is the point.
    expect(root.textContent).toBe("hi");
  });

  it("falls back to the default tag rather than the forbidden one, so the hole is invisible on screen", () => {
    // The reason this has never bitten: `reconcile`'s render key coerces a
    // bound variant to "body", so a forbidden value produces a <p> rather
    // than an element named after it. The hole is therefore silent, not
    // merely unchecked — and silence is what makes it worth a test.
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Text", text: "hi", variant: { path: "/v" } },
        ],
      },
    });
    r.handle({
      version: "v0.9.1",
      updateDataModel: { surfaceId: "dialog", path: "/v", value: "h7" },
    });

    // NB: the renderer wraps each surface in a `[data-surface]` div, so the
    // component element is a grandchild of the host, not a child.
    const el = root.querySelector('[data-component="Text"]') as HTMLElement;
    expect(el.tagName).toBe("P"); // not an element named after "h7"
    expect(el.getAttribute("data-render-key")).toBe("Text:body");
  });

  it("is WIDER than ORIGIN.md records: an undeclared property is accepted in silence", () => {
    // PROVENANCE.md defect 5. `validate` iterates the props the CATALOGUE
    // declares, never the props the MESSAGE carries, so an unknown property
    // is not rejected and not reported. ORIGIN.md describes only the enum
    // bypass, which is the narrower statement.
    //
    // Safe today only by an invariant of two functions: `build`/`apply`
    // never read `class`, `className` or `style` off a message. Nothing in
    // validation enforces that, and 06b's tests assert the invariant rather
    // than the check — so this is pinned here, where the gap actually is.
    const r = createRenderer(root, shellCatalog);
    r.handle(create);

    expect(() =>
      r.handle({
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "dialog",
          components: [
            {
              id: "root",
              component: "Text",
              text: "hi",
              notAProperty: "accepted",
              onclick: "alert(1)",
              style: "color:red",
            },
          ],
        },
      }),
    ).not.toThrow();

    // Accepted, and dropped on the floor — which is the mitigation, and is
    // not the same thing as being rejected.
    const el = root.querySelector('[data-component="Text"]') as HTMLElement;
    expect(el.getAttribute("style")).toBeNull();
    expect(el.getAttribute("onclick")).toBeNull();
    expect(el.getAttribute("notAProperty")).toBeNull();
  });
});

describe("HOLE 2 — reconciliation is O(tree) per update", () => {
  /**
   * `lib/ORIGIN.md`: "Reconciliation is O(tree) per update, with no
   * path-to-component dependency map. Fine for dialogs, wrong for lists."
   *
   * Why it is not closed here: the fix is a path-to-component dependency
   * map, which is a new subsystem, and `03-a2ui-binding/README.md` notes
   * that list rendering — the case that needs it — does not exist yet
   * either. Building the index before the feature that justifies it would be
   * speculative.
   *
   * Measured rather than asserted on a clock: every `validate` call goes
   * through `catalog.components[name]`, so a counting catalogue gives an
   * exact count of components re-walked per message. No timing, nothing to
   * race.
   */

  /** The shell catalogue, counting every component-definition lookup. */
  const countingCatalog = (): { catalog: Catalog; count: () => number } => {
    let n = 0;
    const components = new Proxy(shellCatalog.components as Record<string, ComponentDef>, {
      get(target, key: string) {
        n++;
        return target[key];
      },
    });
    return {
      catalog: { catalogId: shellCatalog.catalogId, components },
      count: () => n,
    };
  };

  /** A Column of `size` Text children, one of them bound to `/v`. */
  const tree = (size: number): A2uiMessage => ({
    version: "v0.9.1",
    updateComponents: {
      surfaceId: "dialog",
      components: [
        {
          id: "root",
          component: "Column",
          children: Array.from({ length: size }, (_, i) => `t${i}`),
        },
        ...Array.from({ length: size }, (_, i) => ({
          id: `t${i}`,
          component: "Text",
          text: i === 0 ? ({ path: "/v" } as unknown as string) : `row ${i}`,
        })),
      ],
    },
  });

  it("re-walks every component on a data update that can only affect one", () => {
    const small = countingCatalog();
    const rSmall = createRenderer(root, small.catalog);
    rSmall.handle(create);
    rSmall.handle(tree(5));
    const beforeSmall = small.count();
    rSmall.handle({
      version: "v0.9.1",
      updateDataModel: { surfaceId: "dialog", path: "/v", value: "x" },
    });
    const smallCost = small.count() - beforeSmall;

    const big = countingCatalog();
    const otherRoot = document.createElement("div");
    document.body.appendChild(otherRoot);
    const rBig = createRenderer(otherRoot, big.catalog);
    rBig.handle(create);
    rBig.handle(tree(50));
    const beforeBig = big.count();
    rBig.handle({
      version: "v0.9.1",
      updateDataModel: { surfaceId: "dialog", path: "/v", value: "x" },
    });
    const bigCost = big.count() - beforeBig;

    process.stdout.write(
      `\n  one updateDataModel re-validated ${smallCost} components in a 6-node tree ` +
        `and ${bigCost} in a 51-node tree — O(tree), not O(bound)\n`,
    );

    // PINS THE HOLE. The cost of a single-path update scales with the TREE,
    // not with the number of components bound to that path (which is one).
    // A dependency map makes both numbers constant and turns this red.
    expect(smallCost).toBe(6);
    expect(bigCost).toBe(51);
    expect(bigCost).toBeGreaterThan(smallCost);
  });

  it("costs the same when the update touches a path NOTHING is bound to", () => {
    // The sharper form, and the one a dependency map fixes first: a write to
    // an unreferenced path still repaints the whole tree. Nothing on screen
    // can change, and every component is re-validated anyway.
    const c = countingCatalog();
    const r = createRenderer(root, c.catalog);
    r.handle(create);
    r.handle(tree(20));
    const before = c.count();
    r.handle({
      version: "v0.9.1",
      updateDataModel: { surfaceId: "dialog", path: "/nobody/reads/this", value: 1 },
    });
    expect(c.count() - before).toBe(21);
  });
});
