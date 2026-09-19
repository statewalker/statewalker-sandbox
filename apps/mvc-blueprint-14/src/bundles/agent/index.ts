import {
  type AgentAction,
  type AgentDataSource,
  agentActionsSlot,
  agentDataSlot,
  generatedKind,
  specGeneratorAdapter,
} from "@b/agent/api";
import { type ComponentDefinition, catalogSlot } from "@b/catalog/api";
import { menuSlot, panelsSlot } from "@b/shell/api";
import {
  createSpecStreamCompiler,
  type PropResolutionContext,
  resolveActionParam,
  type Spec,
} from "@json-render/core";
import { type Controller, getConfig, getLogger, getSlots, newRegistry, useFields } from "@kernel";
import { type AgentCatalog, buildCatalog } from "@kit/catalog";
import { type CommitActionModel, createCommitAction, drainCommits, on } from "@kit/commit";
import { createGeneratedModel } from "./generated.model.js";
import { checkComplete, checkPartial, type PolicyContext } from "./policy.js";

const fields = useFields({
  slots: getSlots,
  log: getLogger,
  config: getConfig,
  generator: specGeneratorAdapter.get,
});

/** `sys:config` key: the request the Assistant sends (default below). */
export const AGENT_REQUEST_KEY = "agent:request";
const DEFAULT_REQUEST = "Make a todo for each selected contact";
const PANEL_ID = "agent:assistant";

type Params = Readonly<Record<string, unknown>>;
type Binding = { readonly action: string; readonly params?: Params };

/**
 * `agent`: the agent controller. It aggregates the vocabulary (`ui:catalog` components +
 * `agent:actions`) into a json-render catalog, offers "Assistant…" in the main menu, and for each
 * request runs one SESSION:
 *
 * 1. publishes a `jr:generated` side panel whose model is a fresh `GeneratedView`;
 * 2. streams the generator's SpecStream, checking every element as it arrives (catalog + policy):
 *    the panel shows only a valid prefix, and the first invalid element refuses the whole spec
 *    (`invalid`, nothing rendered, stream aborted);
 * 3. when the stream ends, checks the whole spec, then creates one commit action per bound,
 *    allow-listed action — capture = the binding's params resolved against the model AT SUBMIT —
 *    and drains them into the contributing bundle's `run` (an existing command).
 *
 * Close (or a new request, or deactivation) ends the session: abort, withdraw, dispose — nothing
 * is written after that.
 */
export const activate: Controller = async (context) => {
  const { slots, log: rootLog, config, generator } = fields(context);
  const log = rootLog.child({ bundle: "agent" });
  const [register, cleanup] = newRegistry();
  let active = true;

  // ── the vocabulary, aggregated from independent bundles ────────────────────────────────────
  let components: ReadonlyMap<string, ComponentDefinition> = new Map();
  let actions: ReadonlyMap<string, AgentAction> = new Map();
  let sources: ReadonlyMap<string, AgentDataSource> = new Map();
  let policy: PolicyContext | undefined;
  const currentPolicy = (): PolicyContext => {
    if (!policy) {
      const catalog: AgentCatalog = buildCatalog(components, actions);
      policy = {
        catalog,
        props: new Map([...components].map(([name, def]) => [name, def.props])),
        events: new Map([...components].map(([name, def]) => [name, def.events])),
        actions: new Set(actions.keys()),
      };
    }
    return policy;
  };
  const systemPrompt = () =>
    currentPolicy().catalog.prompt({
      customRules: [...sources].map(([key, s]) => `DATA /data/${key}: ${s.description}`),
    });

  let session: Session | undefined;
  register(
    slots.observe(catalogSlot, (entries) => {
      components = entries;
      policy = undefined;
      session?.revalidate();
    }),
  );
  register(
    slots.observe(agentActionsSlot, (entries) => {
      actions = entries;
      policy = undefined;
      session?.revalidate();
    }),
  );
  register(
    slots.observe(agentDataSlot, (entries) => {
      sources = entries;
      session?.followData();
    }),
  );

  // ── a session: one request, one panel, one model ───────────────────────────────────────────
  interface Session {
    end(): void;
    revalidate(): void;
    followData(): void;
  }

  const startSession = (request: string): Session => {
    let open = true;
    const disposers: (() => void)[] = [];
    const abort = new AbortController();
    const model = createGeneratedModel((path) =>
      log.warn("agent: refused a write outside the form group", { path }),
    );
    let generated: Map<string, CommitActionModel<Params>> = new Map();
    let complete: Spec | undefined;

    const refuse = (issues: readonly string[]) => {
      model.control.publishSpec(null);
      model.control.publishStatus({ phase: "invalid", issues });
      log.warn("agent: spec refused", { issues });
      abort.abort();
    };

    let dataOffs: (() => void)[] = [];
    const publishData = () =>
      model.control.publishData(
        Object.fromEntries([...sources].map(([key, s]) => [key, structuredClone(s.get())])),
      );
    const followData = () => {
      for (const off of dataOffs) off();
      dataOffs = [...sources.values()].map((s) => s.on(() => open && publishData()));
      publishData();
    };

    const self: Session = {
      end: () => {
        if (!open) return;
        open = false;
        if (session === self) session = undefined;
        abort.abort();
        for (const off of dataOffs) off();
        for (const d of disposers.splice(0).reverse()) d();
        for (const a of generated.values()) a.dispose();
        model.dispose();
      },
      revalidate: () => {
        if (!open) return;
        const spec = complete;
        if (!spec) return;
        const issues = checkComplete(spec, currentPolicy());
        if (issues.length > 0) refuse(issues);
      },
      followData,
    };
    followData();

    // Publish, then drain Close.
    disposers.push(
      slots.register(panelsSlot, PANEL_ID, {
        kind: generatedKind,
        title: "Assistant",
        placement: "side",
        order: 30,
        model: model.view,
      }),
    );
    const isLive = () => open && active;
    disposers.push(
      drainCommits(
        {
          isActive: isLive,
          onError: (e) => log.error("agent: close failed", { error: String(e) }),
        },
        on(model.close.control, () => self.end()),
      ),
    );

    const ready = (spec: Spec) => {
      const issues = checkComplete(spec, currentPolicy());
      if (issues.length > 0) return refuse(issues);
      complete = spec;
      const bindings: [string, Binding][] = Object.values(spec.elements).flatMap((el) =>
        Object.values((el.on ?? {}) as Record<string, Binding>).map(
          (b) => [b.action, b] as [string, Binding],
        ),
      );
      generated = new Map(
        bindings.map(([name, binding]) => [
          name,
          createCommitAction<Params>({
            label: name,
            // Commit time: the binding's params, resolved against the model at submit.
            capture: () => {
              const ctx = { stateModel: model.state() } as unknown as PropResolutionContext;
              return Object.fromEntries(
                Object.entries(binding.params ?? {}).map(([k, v]) => [
                  k,
                  resolveActionParam(v, ctx),
                ]),
              );
            },
          }),
        ]),
      );
      model.control.publishActions(
        Object.fromEntries([...generated].map(([name, a]) => [name, a.view])),
      );
      model.control.publishStatus({ phase: "ready", issues: [] });
      disposers.push(
        drainCommits(
          {
            isActive: isLive,
            onError: (error) => {
              log.warn("agent: action failed", { error: String(error) });
              model.control.publishOutcome(`Failed: ${String(error)}`);
            },
          },
          ...[...generated].map(([name, a]) =>
            on(a.control, async (params) => {
              const action = actions.get(name); // removed meanwhile ⇒ refused
              if (!action) {
                model.control.publishOutcome(`Refused: ${name} is no longer available`);
                return;
              }
              const parsed = action.params.safeParse(params);
              if (!parsed.success) {
                log.warn("agent: action params refused", { action: name, params });
                model.control.publishOutcome(
                  `Refused: ${name} — ${parsed.error.issues[0]?.message}`,
                );
                return;
              }
              await action.run(parsed.data as never);
              if (open) model.control.publishOutcome(`Done: ${name}`);
            }),
          ),
        ),
      );
    };

    const stream = async () => {
      const compiler = createSpecStreamCompiler<Spec>();
      const req = { request, system: systemPrompt(), data: model.view.getData() };
      try {
        for await (const chunk of generator.generate(req, abort.signal)) {
          if (!open || abort.signal.aborted) return; // 0 writes after close
          const { result } = compiler.push(chunk);
          const issues = checkPartial(result, currentPolicy());
          if (issues.length > 0) return refuse(issues);
          show(result);
        }
        if (!open || abort.signal.aborted) return;
        const { result } = compiler.push("\n");
        show(result);
        ready(result);
      } catch (error) {
        if (!open) return;
        model.control.publishSpec(null);
        model.control.publishStatus({ phase: "error", issues: [String(error)] });
        log.warn("agent: generation failed", { error: String(error) });
      }
    };
    /** The valid prefix: the elements (never `state` — the seed goes to the form group). */
    const show = (partial: Spec) => {
      if (!partial.root) return;
      model.control.publishSpec(
        structuredClone({ root: partial.root, elements: partial.elements ?? {} }),
      );
      const seed = (partial as { state?: { form?: Params } }).state?.form;
      if (seed && typeof seed === "object") model.control.seed(seed);
    };
    void stream();
    return self;
  };

  // ── the menu item ──────────────────────────────────────────────────────────────────────────
  const assistant = createCommitAction<{ request: string }>({
    label: "Assistant…",
    capture: () => ({ request: String(config[AGENT_REQUEST_KEY] ?? DEFAULT_REQUEST) }),
  });
  register(() => assistant.dispose());
  register(
    drainCommits(
      {
        isActive: () => active,
        onError: (e) => log.error("agent: could not start", { error: String(e) }),
      },
      on(assistant.control, ({ request }) => {
        session?.end();
        session = startSession(request);
      }),
    ),
  );
  register(
    slots.provide(menuSlot, {
      id: "agent.assistant",
      group: "agent",
      groupLabel: "Assistant",
      order: 10,
      action: assistant.view,
    }),
  );

  return async () => {
    active = false;
    session?.end();
    await cleanup();
  };
};
