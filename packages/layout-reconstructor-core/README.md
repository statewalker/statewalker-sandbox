# @statewalker/layout-reconstructor-core

> **Experimental / internal.** Private package in `statewalker-sandbox`. Not published to npm. No consumer in this repository.

## What it is

Turns a set of labelled rectangles with absolute positions into a CSS-grid-style layout: row and
column track sizes (`px` or `fr`), a named-areas matrix, and nested grids for blocks that contain
other blocks.

## Why it exists

Layouts drawn or detected as absolute boxes are hard to edit and do not resize. A grid description
keeps the structure (which block sits next to which) and states sizes as proportions where the
boxes allow it.

## How to use

Entry point: `.` (`src/index.ts`). The main call is `reconstructGrid(blocks, options?)`.

| Option | Default | Meaning |
| --- | --- | --- |
| `snapTolerance` | 20 | Edges closer than this are snapped together. |
| `discoverFractions` | `true` | Replace proportional tracks with `fr` units. |
| `fractionTolerance` | 0.05 | How close sizes must be to count as proportional. |
| `containerWidth`, `containerHeight` | inferred | Container size in the same units as the blocks. |

The pipeline steps are exported too: `snapEdges`, `buildContainmentTree`,
`buildTopologyByEdgeProjection`, `suggestColumnCounts`, `mergeEmptyTracks`, `solveTrackSizes`,
`detectProportionalTracks`, `buildAreasMatrix`, `computeTrackSizes`, `simplifyGridConfig`,
`simplifyTrackSizes`, and the types `InputBlock`, `GridConfig`, `ReconstructOptions` and others.

## Examples

```ts
import { reconstructGrid } from "@statewalker/layout-reconstructor-core";

const grid = reconstructGrid([
  { label: "header", top: 0, left: 0, width: 1000, height: 100 },
  { label: "nav", top: 100, left: 0, width: 250, height: 900 },
  { label: "main", top: 100, left: 250, width: 750, height: 900 },
]);
// grid.rows, grid.columns: SizeExpression[] ({ value, unit })
// grid.areas: string[][] of block labels; grid.children: nested GridConfig per container block
```

## Internals

The pipeline (`src/reconstruct.ts`): snap edges and detect containment; project block edges to
grid lines; solve track sizes with the Cassowary solver from `@lume/kiwi`; assign blocks to cells;
discover `fr` units and merge thin tracks; recurse into containers. An empty input returns
`{ rows: [], columns: [], areas: [] }`. The only runtime dependency is `@lume/kiwi`.

```sh
pnpm --filter @statewalker/layout-reconstructor-core test
```

## License

MIT
