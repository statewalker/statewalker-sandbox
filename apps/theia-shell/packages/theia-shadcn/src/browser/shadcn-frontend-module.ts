import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { PreferenceContribution } from "@theia/core/lib/common/preferences";
import { ContainerModule } from "@theia/core/shared/inversify";
import { ShadcnStyleContribution, ShadcnStylePreferenceContribution } from "./shadcn-style";

export default new ContainerModule((bind) => {
  bind(ShadcnStylePreferenceContribution).toSelf().inSingletonScope();
  bind(PreferenceContribution).toService(ShadcnStylePreferenceContribution);
  bind(ShadcnStyleContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ShadcnStyleContribution);
  bind(CommandContribution).toService(ShadcnStyleContribution);
});
