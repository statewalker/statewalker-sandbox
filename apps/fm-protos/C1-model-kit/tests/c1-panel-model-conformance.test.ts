import { describe, expect, it } from "vitest";
import { Commands } from "@statewalker/shared-commands";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { PanelController, PanelModel, expectNoSelfWake, expectReplacedNotMutated } from "@fm/app";

/**
 * C1 — every model built from here on runs the kit. Applied retroactively to
 * PanelModel so the first model in the tree is held to the rule too.
 */
describe("PanelModel conformance", () => {
  const build = () => {
    const api = new MemFilesApi({ initialFiles: { "/a.txt": "a", "/b.txt": "b" } });
    const model = new PanelModel("p1", "left", "mem://a", "/");
    let reactions = 0;
    const controller = new PanelController(model, api, new Commands(), () => { reactions++; });
    return { model, controller, reactions: () => reactions };
  };

  it("replaces `entries` rather than mutating it", async () => {
    const { model, controller } = build();
    await expectReplacedNotMutated(model, () => model.entries, () => controller.refresh());
  });

  it("cannot be woken by its own controller's writes", async () => {
    const { model, controller, reactions } = build();
    await controller.refresh();
    await expectNoSelfWake(model.input, model, reactions, () => controller.refresh());
  });

  it("exposes input as the only writable surface", () => {
    const { model } = build();
    expect(Object.keys(model)).toContain("input");
    expect(Object.keys(model)).not.toContain("commands");
    expect(Object.keys(model)).not.toContain("api");
  });
});
