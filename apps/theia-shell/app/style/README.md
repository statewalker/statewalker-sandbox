# @theia-shell/app-style

The app's stylesheet: one Tailwind v4 build over the app's extensions, plus the
shadcn/ui tokens and Theia alignment from
[`@theia-shell/theia-shadcn`](../../packages/theia-shadcn). `pnpm build` compiles
`src/app.css` to `lib/app.css`. The frontend module imports it, so Theia's
bundler adds it to `bundle.css`.

It is a separate extension because Theia ignores `theiaExtensions` in the app's
own `package.json` (P3). This is the same reason `app/files` is separate. It also
belongs to the app because only the app knows which extensions' sources hold
Tailwind classes: see the `@source` lines. **Add an extension to the app, and add
its `src` here too**, or its classes will have no CSS.

Three rules keep Tailwind from disturbing Theia:

- **No preflight.** Only `tailwindcss/theme.css` and `tailwindcss/utilities.css`
  are imported. Preflight would reset Theia's CSS (headings, lists, borders).
  The shadcn components get a reset scoped to `[data-slot]` instead.
- **Utilities are not in a cascade layer.** Theia's CSS is unlayered, and an
  unlayered rule beats every layered one. In `@layer utilities`, Theia's
  `.lm-Widget` and similar rules would override our utilities on our own
  elements.
- **No utility may share a class name with Theia's DOM.** The classes are not
  prefixed, so shadcn's class strings stay copyable. But Tailwind generates a
  utility for any matching word in a scanned file, comments included. `.fixed`
  (Monaco's context view) and `.container` (`@theia/callhierarchy`) are
  therefore excluded with `@source not inline(...)`. After a build,
  `node tools/audit-classes.mjs` lists any utility whose name Theia or Monaco
  also use, across every Theia package in `src-gen`. It should say `none`. If it
  does not, exclude the name, or switch to a Tailwind prefix (`tw:`, which
  shadcn's CLI supports).

Tests: `pnpm test` runs 5 unit tests on the compiled `lib/app.css`, so build it
first. They check that there is no preflight, that no utility is in a layer,
that both theme types have tokens, and that the excluded names are absent.
