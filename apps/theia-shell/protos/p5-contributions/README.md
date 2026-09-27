# P5: extension contributions

**Question.** Does a Theia extension that contributes a command, a keybinding,
a main-menu item, an explorer context-menu item and a view work in browser-only
mode?

**Answer: yes, with the standard APIs and nothing special for browser-only.**
The extension is in [`extension/src`](extension/src):

- `P5Contribution extends AbstractViewContribution<P5HelloWidget>` does all
  four jobs at once. `bindViewContribution` registers it as a Command-, Menu-,
  Keybinding- and FrontendApplicationContribution.
- **Command:** `p5.sayHello` shows a toast through `MessageService`.
- **Keybinding:** `ctrlcmd+alt+h`. The palette shows it next to the command.
- **Main menu:** `CommonMenus.HELP`.
- **Explorer context menu:** `NavigatorContextMenu.NAVIGATION` with a
  `UriAwareCommandHandler.MonoSelect` handler, which receives the right-clicked
  file's `URI`. Its path is the `FilesApi` path.
- **View:** a `ReactWidget` created by a `WidgetFactory`, placed in the left
  side bar (`area: "left"`). `AbstractViewContribution` adds the toggle command
  itself. It is labelled **`View: Toggle P5 Hello`** (`Toggle {widgetName}`,
  not "… View"), and it also appears under *View*.
- The package declares both `frontend` and `frontendOnly` modules, so the same
  extension also works in a Theia app that has a backend.

## Findings (test mechanics)

- **Keybindings are not live when the explorer first renders.** An F1 pressed
  immediately is lost. The test retries F1 until the palette input has focus.
- **Each notification is rendered twice:** as a toast and in the closed
  notification center. Assertions look only inside `.theia-notification-toasts`.
- Pick palette entries with Enter on the focused row; clicking the row was not
  reliable.
- Compiling React widgets needs `@types/react` 19, matching Theia's React 19.3.

## Red / green

- Red 1: empty `ContainerModule`, 5 of 5 failing.
- Red 2: with the implementation, `tsc` failed with no React types (TS2497 and
  TS7026).
- Red 3: 3 of 5 failing on test mechanics (duplicate toasts, the F1 race, the
  toggle label).
- Green: `5 passed (19.9s)`.
