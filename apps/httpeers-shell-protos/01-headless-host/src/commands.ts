// DERIVED-FROM-NOTE: 11-Prototype 1 API Reference.md §5 (the four declarations,
// their keys, their policies, their input/output shapes, `shellCommands`)
// DERIVED-FROM-NOTE: 10-Prototype 1 Functional Description.md §3.2 and §3.4
// (why `.optional()` and never `.default()`; Zod 4's two-argument `z.record`)
//
// RECONSTRUCTED, NOT RECOVERED.
//
// The shell standard library. Four commands, no slots: notifications and
// dialogs are *invoked*, never *enumerated*, and "does anyone enumerate this?"
// is the test that decides which mechanism a feature belongs to.

import { Command } from "@statewalker/shared-commands";
import { z } from "zod";

// Every field is `.optional()` and never `.default()`.
//
// `CommandDeclaration` types input as `StandardSchemaV1<P, P>` — the same type
// parameter on both sides. Standard Schema's output type is therefore also its
// input type, so a Zod `.default()` makes the defaulted field *required for
// callers*, exactly inverting what a default is for. Defaults are applied
// inside the handler instead. See enablement of this trap in
// tests/commands.test.ts.

/** `shell:notify` — async: reject on no handlers, wait on observers-only. */
export const NotifyCommand = Command.async("shell:notify")
  .input(
    z.object({
      message: z.string(),
      severity: z.enum(["info", "warning", "error"]).optional(),
      timeoutMs: z.int().positive().optional(),
    }),
  )
  .output(z.object({ id: z.string() }))
  .label("Notify")
  .description("Show a transient notification to the user.")
  .build();

/**
 * `shell:dialog:open` — required.
 *
 * `surface` is an untyped record pending the A2UI catalogue, which is why this
 * command is `ui-only` in the projection policy: an agent has no way to
 * construct the argument.
 *
 * Zod 4 changed `z.record()` to require both a key and a value schema; the
 * READMEs still show the Zod 3 one-argument form.
 */
export const OpenDialogCommand = Command.required("shell:dialog:open")
  .input(
    z.object({
      title: z.string(),
      surface: z.record(z.string(), z.unknown()),
      dismissable: z.boolean().optional(),
    }),
  )
  .output(
    z.object({
      outcome: z.enum(["submitted", "dismissed"]),
      data: z.record(z.string(), z.unknown()).optional(),
    }),
  )
  .label("Open dialog")
  .description("Open a modal dialog rendering the given surface.")
  .build();

/** `shell:view:open` — required. */
export const OpenViewCommand = Command.required("shell:view:open")
  .input(
    z.object({
      viewId: z.string(),
      surface: z.enum(["main", "sidebar", "panel"]).optional(),
    }),
  )
  .output(z.object({ opened: z.boolean() }))
  .label("Open view")
  .description("Reveal a registered view on the requested surface.")
  .build();

/** `shell:palette:show` — silent: waits on both no-handlers and observers-only. */
export const ShowPaletteCommand = Command.silent("shell:palette:show")
  .input(z.object({ filter: z.string().optional() }))
  .output(z.object({ invoked: z.string().nullable() }))
  .label("Show command palette")
  .description("Open the command palette, optionally pre-filtered.")
  .build();

/** The four shell standard-library declarations, exported together. */
export const shellCommands = Object.freeze([
  NotifyCommand,
  OpenDialogCommand,
  OpenViewCommand,
  ShowPaletteCommand,
]);
