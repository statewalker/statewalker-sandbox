import { describe, expect, it } from "vitest";
import { buildContainmentTree, snapEdges } from "../preprocess.ts";
import type { InputBlock } from "../types.ts";

describe("snapEdges", () => {
  it("should snap nearby edges to the same value", () => {
    const blocks: InputBlock[] = [
      { label: "a", left: 0, top: 0, width: 100, height: 50 },
      { label: "b", left: 102, top: 0, width: 100, height: 48 },
    ];
    const result = snapEdges(blocks, 5);
    // b.left (102) should snap to a.right (100)
    expect(result[1].left).toBe(101);
    // b.height boundary (48) should snap to a.height boundary (50)
    expect(result[0].top + result[0].height).toBe(result[1].top + result[1].height);
  });

  it("should not snap edges beyond tolerance", () => {
    const blocks: InputBlock[] = [
      { label: "a", left: 0, top: 0, width: 100, height: 50 },
      { label: "b", left: 120, top: 0, width: 100, height: 50 },
    ];
    const result = snapEdges(blocks, 5);
    expect(result[1].left).toBe(120);
  });

  it("should handle single block", () => {
    const blocks: InputBlock[] = [{ label: "a", left: 10, top: 20, width: 100, height: 50 }];
    const result = snapEdges(blocks, 5);
    expect(result[0]).toEqual(blocks[0]);
  });
});

describe("buildContainmentTree", () => {
  it("should detect simple containment", () => {
    const blocks: InputBlock[] = [
      { label: "outer", left: 0, top: 0, width: 400, height: 300 },
      { label: "inner", left: 10, top: 10, width: 100, height: 100 },
    ];
    const tree = buildContainmentTree(blocks);
    expect(tree).toHaveLength(1);
    expect(tree[0].block.label).toBe("outer");
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].block.label).toBe("inner");
  });

  it("should handle non-overlapping blocks as siblings", () => {
    const blocks: InputBlock[] = [
      { label: "a", left: 0, top: 0, width: 100, height: 100 },
      { label: "b", left: 200, top: 0, width: 100, height: 100 },
    ];
    const tree = buildContainmentTree(blocks);
    expect(tree).toHaveLength(2);
  });

  it("should build nested hierarchy", () => {
    const blocks: InputBlock[] = [
      { label: "outer", left: 0, top: 0, width: 400, height: 300 },
      { label: "middle", left: 10, top: 10, width: 200, height: 200 },
      { label: "inner", left: 20, top: 20, width: 50, height: 50 },
    ];
    const tree = buildContainmentTree(blocks);
    expect(tree).toHaveLength(1);
    expect(tree[0].block.label).toBe("outer");
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].block.label).toBe("middle");
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].block.label).toBe("inner");
  });

  it("should handle multiple children", () => {
    const blocks: InputBlock[] = [
      { label: "parent", left: 0, top: 0, width: 400, height: 300 },
      { label: "child1", left: 10, top: 10, width: 100, height: 100 },
      { label: "child2", left: 200, top: 10, width: 100, height: 100 },
    ];
    const tree = buildContainmentTree(blocks);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(2);
  });
});
