# @theia-shell/theia-shadcn

[shadcn/ui](https://ui.shadcn.com/) for Theia: the components, the design
tokens, and a CSS-only alignment of Theia's own menus, dialogs, buttons, inputs
and toasts with them. It follows the approach in the *Theia — theming &
shadcn/ui alignment* note: shadcn's variables are the single source of truth,
Theia's DOM is restyled with them, and its rendering is left alone.

## Components

`Button`, `Badge`, `Card` (with `CardHeader`, `CardTitle`, `CardDescription`,
`CardAction`, `CardContent`, `CardFooter`), `Input`, `Kbd`/`KbdGroup`,
`Separator`, and `cn()`. They are shadcn's *new-york* v4 source with two
changes: React comes from `@theia/core/shared/react`, so the components share
Theia's React instance, and Radix is imported per primitive
(`@radix-ui/react-slot`, `@radix-ui/react-separator`) rather than through the
`radix-ui` umbrella package. Class strings are unchanged, so later shadcn
updates can be copied over as they are.

```tsx
import { Button } from "@theia-shell/theia-shadcn";

<Button variant="ghost" size="sm" onClick={reveal}>Getting started</Button>;
```

Use them inside `ReactWidget`s. Components that portal (Dialog, Popover,
Tooltip, DropdownMenu) are not here yet. Radix renders their content into
`body`, so it needs a `z-index` above Theia's dialog overlay (5000). Theia's
global keybinding handler and Lumino's focus tracking can also fight Radix's
focus trap. Add one only together with an e2e test of Esc, Tab and shortcuts
while it is open.

## The stylesheet: `src/browser/style/theme.css`

This is a Tailwind v4 **source** file, so it cannot be imported as it is. An
app compiles it into its own Tailwind entry. See [`app/style`](../../app/style)
for how, including why preflight is left out. It holds:

1. **Tokens per Theia theme type.** Theia puts `theia-light`, `theia-dark`,
   `theia-hc` or `theia-hcLight` on `<body>`. Light and dark get shadcn's
   *neutral* values. High-contrast themes map the tokens *to* Theia's colours,
   so they keep their contrast.
2. **`@theme inline`**, which turns the tokens into utilities (`bg-primary`,
   `rounded-md` = `var(--radius) - 2px`, …). The `dark:` variant is keyed to
   `.theia-dark` and `.theia-hc`.
3. **Theia's variables mapped to the tokens** (`--theia-menu-*`,
   `--theia-button-*`, notifications, `--theia-ui-font-family`), for light and
   dark only. They are defined on `body`, not `:root`, because the active VS
   Code theme writes `--theia-*` on `:root`.
4. **Native widgets in shadcn's shape.** Each is written with `@apply` and the
   class string of the matching shadcn component:
   - Lumino menus: `DropdownMenuContent` / `DropdownMenuItem`;
   - `.dialogBlock`: `DialogContent`;
   - `.theia-button`: `Button`, with `.secondary` as `outline`;
   - `.theia-input`: `Input`;
   - notification toasts.

   Every selector starts with `body`, so it beats Theia's rule whatever order
   the bundle puts the stylesheets in.
5. **A scoped preflight** for `[data-slot]` elements (the shadcn components):
   no UA borders, margins or button chrome. It is in `@layer base`, so any
   utility overrides it.
6. **`prose-shadcn`**, which colours Tailwind Typography with the tokens.

Two things the note did not anticipate, found while testing:

- Lumino menu items are `display: table-row`, and table rows cannot be rounded.
  So the radius goes on the first and last cells, as Theia's own CSS does, and
  `.lm-Menu-item { border-radius }` would do nothing.
- Theia's rule for the active item's cells (`.lm-Menu-item.lm-mod-active >
  div:first-child`, specificity 0,3,0) outranks a plain `body .lm-Menu-item >
  div:first-child`. A `body` prefix alone is not always enough. Check the
  specificity.

Tests: `pnpm test` runs 6 unit tests (`cn`, the button variants, `asChild`, and
the `data-slot` of every component). The look in the running app is covered by
[`app/tests/shadcn.spec.ts`](../../app/tests/shadcn.spec.ts).
