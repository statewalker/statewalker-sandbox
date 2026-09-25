import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import type { Command, CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import {
  type PreferenceContribution,
  type PreferenceSchema,
  PreferenceScope,
  PreferenceService,
} from "@theia/core/lib/common/preferences";
import { inject, injectable } from "@theia/core/shared/inversify";

/** `"theia"` is stock Theia; `"shadcn"` restyles it. Either works with every colour theme. */
export type ShadcnStyle = "theia" | "shadcn";

export const STYLE_PREFERENCE = "appearance.style";
/** Set on <body> while the shadcn/ui style is on; every rule of that style is scoped to it. */
export const STYLE_CLASS = "shadcn-ui";

export const styleSchema: PreferenceSchema = {
  properties: {
    [STYLE_PREFERENCE]: {
      type: "string",
      enum: ["theia", "shadcn"],
      enumDescriptions: [
        "Theia's own look, from the colour theme.",
        "shadcn/ui: its colours for light and dark themes, and its shape for menus, dialogs, buttons and inputs.",
      ],
      default: "theia",
      description: "The visual style of the workbench. It applies on top of any colour theme.",
      scope: PreferenceScope.User,
    },
  },
};

export namespace ShadcnStyleCommands {
  export const TOGGLE: Command = {
    id: "appearance.toggleShadcnStyle",
    category: "Appearance",
    label: "Toggle shadcn/ui Style",
  };
}

@injectable()
export class ShadcnStylePreferenceContribution implements PreferenceContribution {
  readonly schema = styleSchema;
}

/** Keeps the <body> class in step with the preference, and offers a command to flip it. */
@injectable()
export class ShadcnStyleContribution
  implements FrontendApplicationContribution, CommandContribution
{
  @inject(PreferenceService) protected readonly preferences!: PreferenceService;

  get style(): ShadcnStyle {
    return this.preferences.get<ShadcnStyle>(STYLE_PREFERENCE, "theia");
  }

  onStart(): void {
    this.preferences.ready.then(() => this.apply());
    this.preferences.onPreferenceChanged((change) => {
      if (change.preferenceName === STYLE_PREFERENCE) this.apply();
    });
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ShadcnStyleCommands.TOGGLE, {
      execute: () =>
        this.preferences.set(
          STYLE_PREFERENCE,
          this.style === "shadcn" ? "theia" : "shadcn",
          PreferenceScope.User,
        ),
    });
  }

  protected apply(): void {
    document.body.classList.toggle(STYLE_CLASS, this.style === "shadcn");
  }
}
