import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { injectable, postConstruct } from "@theia/core/shared/inversify";
import type * as React from "@theia/core/shared/react";

@injectable()
export class P5HelloWidget extends ReactWidget {
  static readonly ID = "p5-hello-view";
  static readonly LABEL = "P5 Hello";

  @postConstruct()
  protected init(): void {
    this.id = P5HelloWidget.ID;
    this.title.label = P5HelloWidget.LABEL;
    this.title.caption = P5HelloWidget.LABEL;
    this.title.closable = true;
    this.title.iconClass = "codicon codicon-smiley";
    this.update();
  }

  protected render(): React.ReactNode {
    return <div style={{ padding: 8 }}>Hello view from P5</div>;
  }
}
