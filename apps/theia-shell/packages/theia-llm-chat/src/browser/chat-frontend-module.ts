import "../../src/browser/style/chat.css";
import { bindViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { ContainerModule } from "@theia/core/shared/inversify";
import { ChatContribution } from "./chat-contribution";
import { ChatService } from "./chat-service";
import { ChatWidget } from "./chat-widget";

export default new ContainerModule((bind) => {
  bind(ChatService).toSelf().inSingletonScope();
  bindViewContribution(bind, ChatContribution);
  bind(ChatWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: ChatWidget.ID,
      createWidget: () => container.get(ChatWidget),
    }))
    .inSingletonScope();
});
