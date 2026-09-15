import { LogsController } from "@logs/app";
import { ProgressController } from "@progress/app";
import { progressDomRenderers } from "@progress/ui/dom";
import { getLogger } from "@statewalker/shared-logger";
import { newRegistry } from "@statewalker/shared-registry";
import { StatsController } from "@stats/app";
import { statsDomRenderers } from "@stats/ui/dom";
import { statsReactRenderers } from "@stats/ui/react";
import { type AppContext, setCommands, setSlots } from "@sys";
import { TodoController } from "@todo/app";
import { MemTodoApi, registerTodoCommands, setTodoApi, type Todo, type TodoApi } from "@todo/core";
import { todoRenderers } from "@todo/ui";
import { mountDomHost } from "@ui/dom";
import { mountReactHost } from "@ui/react";
import { observeCoverage, type Unrendered } from "./coverage.js";
import { createLayout } from "./layout.js";
import { TracingCommands, TracingSlots } from "./tracing.js";

/**
 * The composition root — the only module that knows every feature and both
 * hosts. Everything else meets through the context's services, slots,
 * commands and models.
 */

export const seedTodos: readonly Todo[] = [
  { id: "seed-1", title: "Read the v2 spec", done: true },
  { id: "seed-2", title: "Add a todo of your own", done: false },
  { id: "seed-3", title: "Tick it, then clear completed", done: false },
];

export interface StartOptions {
  api?: TodoApi;
  sampleDelayMs?: number;
  tickMs?: number;
  /** Called for each contribution no host can render (also logged and warned). */
  onUnrendered?: (unrendered: Unrendered) => void;
}

export interface RunningApp {
  readonly context: AppContext;
  dispose(): Promise<void>;
}

export function startApp(root: HTMLElement, options: StartOptions = {}): RunningApp {
  const ctx: AppContext = {};
  const [register, cleanup] = newRegistry();

  // Services. The tracers resolve the logger per call: LogsController replaces it below.
  const commands = new TracingCommands(() => getLogger(ctx));
  const slots = new TracingSlots(() => getLogger(ctx));
  const api = options.api ?? new MemTodoApi([...seedTodos]);
  setCommands(ctx, commands);
  setSlots(ctx, slots);
  setTodoApi(ctx, api);
  register(registerTodoCommands(commands, api));

  const regions = createLayout(root);
  register(() => root.replaceChildren());

  // Order matters. LogsController FIRST: it overwrites the logger, and every other
  // controller resolves the logger in activate(). TodoController before
  // StatsController: stats asks todos:summary once, on activation, and with no
  // handler yet its baseline stays unknown. ProgressController may come at any
  // point: it only observes ops:running, which delivers earlier contributions.
  const controllers = [
    new LogsController(),
    new TodoController({ sampleDelayMs: options.sampleDelayMs }),
    new StatsController({ tickMs: options.tickMs }),
    new ProgressController(),
  ];
  for (const controller of controllers) {
    controller.activate(ctx);
    register(() => controller.dispose());
  }

  // Hosts: they observe slots, so contributions made above are rendered on arrival.
  const react = mountReactHost({
    slots,
    regions: { main: regions.main, bottom: regions.bottom },
    dialogs: regions.dialogs,
    renderers: [...todoRenderers, ...statsReactRenderers],
  });
  register(() => react.dispose());
  const dom = mountDomHost({
    slots,
    regions: { side: regions.side },
    progress: regions.progress,
    renderers: [...statsDomRenderers, ...progressDomRenderers],
  });
  register(() => dom.dispose());

  register(
    observeCoverage(slots, [react, dom], (unrendered) => {
      console.warn("[mvc-blueprint-02] no host renders", unrendered);
      getLogger(ctx).child({ module: "ui" }).warn("ui:unrendered", unrendered);
      options.onUnrendered?.(unrendered);
    }),
  );

  let disposed = false;
  return {
    context: ctx,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await cleanup();
    },
  };
}
