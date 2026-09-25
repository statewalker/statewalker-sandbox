# @theia-shell/theia-shadcn

[shadcn/ui](https://ui.shadcn.com/) for Theia: the components, the design
tokens, and a CSS-only alignment of Theia's own menus, dialogs, buttons, inputs
and toasts with them. It follows the approach in the *Theia — theming &
shadcn/ui alignment* note: shadcn's variables are the single source of truth,
Theia's DOM is restyled with them, and its rendering is left alone.

## Two styles, on top of any colour theme

The style is independent of the colour theme, so one app can run with either
look:

| `appearance.style` | Look |
|---|---|
| `"theia"` (default) | Stock Theia. The shadcn tokens borrow the colour theme's colours (`--primary` is the theme's button colour, `--accent` its list hover, and so on). Theia's widgets are untouched, and the shadcn components in our widgets look native. |
| `"shadcn"` | shadcn/ui. Light and dark themes get shadcn's *neutral* tokens, Theia's colour variables are mapped onto them, and Theia's menus, dialogs, buttons, inputs and toasts take shadcn's shape. High-contrast themes keep their own colours and get only the shape. |

Switch it with *Appearance: Toggle shadcn/ui Style* in the command palette, or
in Preferences. The change applies live and is stored as a user preference. The
extension's frontend module registers the preference and the command, and
keeps `shadcn-ui` on `<body>` in step with the preference. Every rule of the
shadcn style is scoped to `body.shadcn-ui`. A unit test in
[`app/style`](../../app/style) checks that no rule on Theia's own classes
escapes that scope.

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

## Icons: Lucide (not yet used)

shadcn's icon set is [Lucide](https://lucide.dev/). In Theia it comes in two
ways, because Theia does not draw icons the way shadcn does.

- **Inside React widgets: `lucide-react`.** Its only peer is React, and here it
  gets the React that Theia shares, so it works like any other component, e.g.
  `<Button size="icon"><ZoomIn /></Button>`. Icons are SVG drawn in
  `currentColor`, so they follow the tokens, and `Button` already sizes them
  (`[&_svg:not([class*='size-'])]:size-4`).
- **Theia's own icons: CSS, with `@iconify/tailwind4` and
  `@iconify-json/lucide`.** Commands, tab titles, tab-bar toolbars, view
  containers and the explorer take a CSS *class* (`iconClass`, today always
  `codicon codicon-*`), not a component. The plugin makes each icon a utility,
  `icon-[lucide--zoom-in]`: the SVG is inlined as a data URL and used as a
  mask over `currentColor`. So the icon follows the theme and makes no request,
  which matters because this app is offline. Only icons that are named end up in
  the CSS. The utility also works in `@apply`, which was checked with Tailwind
  4.3. That lets the shadcn style swap Theia's icons with CSS alone, and leaves
  the default style on codicons:

  ```css
  body.shadcn-ui .codicon-zoom-in::before {
    content: "";
    @apply icon-[lucide--zoom-in] size-4;
  }
  ```

  Swapping icons needs a map from codicon to Lucide names, starting with the
  icons our extensions use (zoom, fit, outline, preview, image, PDF), then the
  explorer and activity bar. Each entry is only as good as a test that the
  element is drawn from the Lucide mask.
- **Not `lucide-static`'s icon font.** Its CSS styles every element whose class
  starts with `icon-` and sets its font with `!important`. That can catch class
  names Theia or Monaco use, and the font files would also need bundling.

## The stylesheet: `src/browser/style/theme.css`

This is a Tailwind v4 **source** file, so it cannot be imported as it is. An
app compiles it into its own Tailwind entry. See [`app/style`](../../app/style)
for how, including why preflight is left out. It holds:

1. **Tokens.** By default they map *to* Theia's colour variables, for every
   theme. Under `body.shadcn-ui.theia-light` and `.theia-dark` they take
   shadcn's *neutral* values. Theia puts `theia-<type>` on `<body>`.
2. **`@theme inline`**, which turns the tokens into utilities (`bg-primary`,
   `rounded-md` = `var(--radius) - 2px`, …). The `dark:` variant is keyed to
   `.theia-dark` and `.theia-hc`.
3. **Theia's variables mapped to the tokens** (`--theia-menu-*`,
   `--theia-button-*`, notifications, `--theia-ui-font-family`). This happens
   only under the shadcn style, and only for light and dark. They are defined on `body`, not `:root`, because the active VS
   Code theme writes `--theia-*` on `:root`.
4. **Native widgets in shadcn's shape**, only under the shadcn style. Each is
   written with `@apply` and the
   class string of the matching shadcn component:
   - Lumino menus: `DropdownMenuContent` / `DropdownMenuItem`;
   - `.dialogBlock`: `DialogContent`;
   - `.theia-button`: `Button`, with `.secondary` as `outline`;
   - `.theia-input`: `Input`;
   - notification toasts.

   Every selector starts with `body.shadcn-ui`, so it beats Theia's rule
   whatever order the bundle puts the stylesheets in.
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
