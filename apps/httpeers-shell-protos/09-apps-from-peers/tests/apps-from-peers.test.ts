// DERIVED-FROM-NOTE: 37-Prototype 9: Apps From Peers §3, §4, §5
// DERIVED-FROM-NOTE: 38-Missing Parts and Next Prototypes §2, §3
//
// Rung 9's archive did not survive; its code did, as `lib/peer.ts` inside the
// consolidated shell-core. These tests are RECONSTRUCTED from the notes, not
// recovered — the assertions are the ones note 37 §3–§5 records as having been
// made, re-expressed against the live file.
//
// The rung adds no features. Its entire value is in what it fails to break, so
// every test here is a re-run of an earlier rung's guarantee with a peer as the
// source of the messages.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { shellCatalog } from "../../lib/catalog.js";
import type { A2uiMessage, Component } from "../../lib/renderer.js";
import { mountStandalone, type AppModule } from "../../lib/mount.js";
import { createPeerTransport, mountPeerApp } from "../../lib/peer.js";
import { createShellDock } from "../../lib/dock.js";

const CATALOG_ID = shellCatalog.catalogId;
const SURFACE = "app";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

/** One tree, expressed once, delivered two ways. */
const TREE: Component[] = [
  { id: "root", component: "Column", children: ["title", "field", "hr", "go"] },
  { id: "title", component: "Text", text: "Notes", variant: "h1" },
  {
    id: "field",
    component: "TextField",
    label: "Title",
    value: { path: "/note/title" },
  },
  { id: "hr", component: "Divider" },
  { id: "go", component: "Button", child: "goLabel", variant: "primary",
    action: { event: { name: "save" } } },
  { id: "goLabel", component: "Text", text: "Save" },
];

const peerMessages = (components: Component[] = TREE): A2uiMessage[] => [
  { version: "v0.9.1", createSurface: { surfaceId: SURFACE, catalogId: CATALOG_ID } },
  { version: "v0.9.1", updateComponents: { surfaceId: SURFACE, components } },
  { version: "v0.9.1", updateDataModel: { surfaceId: SURFACE, path: "/note/title", value: "draft" } },
];

/** A peer that serves a fixed list of messages, then completes. */
function peer(
  peerId: string,
  messages: A2uiMessage[] = peerMessages(),
  send?: (event: unknown) => void,
) {
  return createPeerTransport({
    peerId,
    async *messages() {
      for (const m of messages) yield m;
    },
    ...(send ? { send } : {}),
  });
}

/** The same tree as a local module, for the identical-DOM comparison. */
const localModule: AppModule = {
  id: SURFACE,
  activate(host) {
    host.render(TREE);
    host.setData("/note/title", "draft");
  },
};

describe("the central assertion: byte-identical DOM", () => {
  /**
   * §3. Stronger than "both work": identical markup means the peer path adds
   * no wrapper, no sandbox element, no marker attribute and no sanitisation
   * pass. Mutation testing caught a `.peer-sandbox` wrapper here.
   */
  it("renders a peer-served app and a local module to the same innerHTML", async () => {
    const localRoot = document.createElement("div");
    const peerRoot = document.createElement("div");
    document.body.append(localRoot, peerRoot);

    mountStandalone(localRoot, localModule, shellCatalog);
    await mountPeerApp(peerRoot, peer("12D3KooWabc"), shellCatalog);

    expect(peerRoot.innerHTML).toBe(localRoot.innerHTML);
    // Guard the assertion itself: an empty string would satisfy equality.
    expect(localRoot.innerHTML).toContain("Notes");
    expect(peerRoot.querySelectorAll("[data-component]").length).toBe(TREE.length);
  });

  it("adds no attribute, class or element that names the peer", async () => {
    await mountPeerApp(root, peer("12D3KooWabc"), shellCatalog);
    // The peer id must not leak into the rendered surface in ANY form: the
    // identical-DOM test above would already fail, but this says what is
    // being protected rather than only that something changed.
    expect(root.innerHTML).not.toMatch(/12D3KooWabc|peer|provenance|sandbox/i);
  });
});

describe("what holds under peer delivery", () => {
  it("keeps the catalogue as the ONLY gate: a peer sending Iframe fails exactly as a local module does", async () => {
    // §4, mutation 2. Adding a pre-filter to the peer path would make this
    // pass for the WRONG reason — the catalogue would silently become a
    // second line of defence behind an ad-hoc one. Comparing the two failures
    // MESSAGE FOR MESSAGE is what distinguishes "the catalogue rejected it"
    // from "the peer path dropped it first".
    const hostile: Component[] = [{ id: "root", component: "Iframe", src: "https://evil.example" }];

    let localError = "";
    try {
      mountStandalone(document.createElement("div"), { id: SURFACE, activate: (h) => h.render(hostile) }, shellCatalog);
    } catch (err) {
      localError = (err as Error).message;
    }

    let peerError = "";
    try {
      await mountPeerApp(root, peer("12D3KooWabc", peerMessages(hostile)), shellCatalog);
    } catch (err) {
      peerError = (err as Error).message;
    }

    expect(localError).toContain("Iframe");
    expect(peerError).toBe(localError);
    expect(root.querySelector("iframe")).toBeNull();
  });

  it("never turns peer text into markup", async () => {
    const nasty = '<img src=x onerror="globalThis.__pwned = true">';
    await mountPeerApp(
      root,
      peer("12D3KooWabc", peerMessages([
        { id: "root", component: "Text", text: nasty },
      ])),
      shellCatalog,
    );
    expect(root.querySelector("img")).toBeNull();
    expect((globalThis as Record<string, unknown>)["__pwned"]).toBeUndefined();
    expect(root.textContent).toBe(nasty);
  });

  it("refuses a peer offering an unknown catalogId, at createSurface", async () => {
    const wrong: A2uiMessage[] = [
      { version: "v0.9.1", createSurface: { surfaceId: SURFACE, catalogId: "https://evil.example/catalog.json" } },
      { version: "v0.9.1", updateComponents: { surfaceId: SURFACE, components: TREE } },
    ];
    await expect(mountPeerApp(root, peer("12D3KooWabc", wrong), shellCatalog))
      .rejects.toThrow(/Unsupported catalog/);
    expect(root.children.length).toBe(0);
  });

  it("keeps two peers' data models separate", async () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    document.body.append(a, b);

    const mountA = await mountPeerApp(a, peer("peerA"), shellCatalog);
    const mountB = await mountPeerApp(
      b,
      peer("peerB", [
        { version: "v0.9.1", createSurface: { surfaceId: SURFACE, catalogId: CATALOG_ID } },
        { version: "v0.9.1", updateComponents: { surfaceId: SURFACE, components: TREE } },
        { version: "v0.9.1", updateDataModel: { surfaceId: SURFACE, path: "/note/title", value: "other" } },
      ]),
      shellCatalog,
    );

    expect(mountA.renderer.dataModel(SURFACE)).toEqual({ note: { title: "draft" } });
    expect(mountB.renderer.dataModel(SURFACE)).toEqual({ note: { title: "other" } });
  });

  it("propagates a mid-stream transport failure and leaves the shell usable", async () => {
    const transport = createPeerTransport({
      peerId: "12D3KooWabc",
      async *messages() {
        yield peerMessages()[0] as A2uiMessage;
        yield peerMessages()[1] as A2uiMessage;
        throw new Error("stream reset");
      },
    });

    await expect(mountPeerApp(root, transport, shellCatalog)).rejects.toThrow("stream reset");
    // Half-delivered content is still there — the shell did not tear the DOM
    // down on the peer's behalf — and the document is still operable.
    expect(root.textContent).toContain("Notes");
    const other = document.createElement("div");
    document.body.appendChild(other);
    await expect(mountPeerApp(other, peer("peerC"), shellCatalog)).resolves.toBeDefined();
  });

  it("sends actions back to the transport AND to the local handler", async () => {
    const sent: unknown[] = [];
    const onAction = vi.fn();
    await mountPeerApp(root, peer("12D3KooWabc", peerMessages(), (e) => sent.push(e)), shellCatalog, {
      onAction,
    });

    (root.querySelector("button") as HTMLButtonElement).click();

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({ surfaceId: SURFACE, name: "save" });
    // BOTH sides. An earlier version of this rung's suite checked only one
    // side of a boundary and let a mutation through (§4); the local handler
    // firing is not evidence that the peer heard anything.
    expect(sent).toEqual([{ type: "action", surfaceId: SURFACE, name: "save", context: undefined, dataModel: { note: { title: "draft" } } }]);
  });
});

describe("layout serialisation is unchanged by a peer", () => {
  /**
   * §5, last bullet. The peer id survives as part of an origin string and no
   * peer-specific structure appears in the JSON — which is only meaningful if
   * a peer-backed pane and an ordinary HTTPS-backed pane serialise to the
   * SAME SHAPE. That equality is the assertion; "the origin is in there" is
   * not.
   */
  it("serialises a peer pane and an https pane to structurally identical params", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const dock = createShellDock(host);

    dock.addPane({ id: "fromPeer", title: "Peer", origin: peer("12D3KooWabc").origin });
    dock.addPane({ id: "fromWeb", title: "Web", origin: "https://apps.example/notes/" });

    const layout = JSON.parse(JSON.stringify(dock.toJSON())) as {
      panels: Record<string, { params: Record<string, unknown>; contentComponent: string }>;
    };

    const p = layout.panels["fromPeer"];
    const w = layout.panels["fromWeb"];
    expect(Object.keys(p?.params ?? {})).toEqual(Object.keys(w?.params ?? {}));
    expect(Object.keys(p?.params ?? {})).toEqual(["origin"]);
    expect(p?.contentComponent).toBe(w?.contentComponent);
    expect(p?.params["origin"]).toBe("/peer/12D3KooWabc/");

    // And the whole document carries no peer vocabulary beyond that one path.
    const text = JSON.stringify(layout);
    expect(text).not.toMatch(/peerId|transport|libp2p|provenance/i);

    const restored = createShellDock(document.createElement("div"));
    restored.fromJSON(layout);
    expect(restored.originOf("fromPeer")).toBe("/peer/12D3KooWabc/");
    expect(restored.originOf("fromWeb")).toBe("https://apps.example/notes/");
  });
});
