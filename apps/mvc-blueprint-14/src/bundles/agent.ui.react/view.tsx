import type { GeneratedView } from "@b/agent/api";
import type { CatalogRenderProps, ReactCatalogEntry } from "@b/catalog/api/react";
import {
  type ComponentRegistry,
  type ComponentRenderProps,
  JSONUIProvider,
  Renderer,
} from "@json-render/react";
import type { ActionView } from "@kernel";
import { ActionButton, useModel } from "@kit/react";
import { type ComponentType, createContext, useContext } from "react";

/**
 * The generic `jr:generated` renderer: json-render walks the validated spec and resolves props
 * against `model.store` (controlled mode); each catalog implementation is wrapped so it sees only
 * `action(event)` (our ActionView for the allow-listed binding) and `write(prop)` (the store's
 * `set` on its bound pointer). json-render's `emit`, its ActionProvider and its built-ins are never
 * reachable from a component.
 */

interface Generated {
  readonly actions: Readonly<Record<string, ActionView>>;
  readonly model: GeneratedView;
}
const GeneratedContext = createContext<Generated | null>(null);

/** One catalog implementation, adapted to json-render's component contract. */
export function adapt(component: ReactCatalogEntry["component"]) {
  const Impl = component as unknown as ComponentType<CatalogRenderProps>;
  return function Adapted({ element, children, bindings, loading }: ComponentRenderProps) {
    const generated = useContext(GeneratedContext);
    const action = (event: string) => {
      const binding = (element.on as Record<string, { action?: string }> | undefined)?.[event];
      return binding?.action ? generated?.actions[binding.action] : undefined;
    };
    const write = (prop: string, value: unknown) => {
      const path = bindings?.[prop];
      if (path) generated?.model.store.set(path, value);
    };
    return (
      <Impl props={element.props} loading={loading} action={action} write={write}>
        {children}
      </Impl>
    );
  };
}

/** Model identity → a key, so a new model re-creates json-render's providers (host rule). */
const ids = new WeakMap<object, number>();
let next = 0;
const keyOf = (model: object) => {
  let id = ids.get(model);
  if (id === undefined) {
    id = ++next;
    ids.set(model, id);
  }
  return id;
};

export interface RegistrySource {
  get(): ComponentRegistry;
  subscribe(listener: () => void): () => void;
}

const PHASE_TEXT = {
  streaming: "Generating…",
  ready: "Ready",
  invalid: "Refused: the generated UI is outside the catalog",
  error: "The generator failed",
} as const;

export function createGeneratedPanel(registry: RegistrySource) {
  return function GeneratedPanel({ model }: { model: GeneratedView }) {
    const components = useModel(registry.get, registry.subscribe);
    const spec = useModel(model.getSpec, model.onSpecUpdate);
    const status = useModel(model.getStatus, model.onStatusUpdate);
    const actions = useModel(model.getActions, model.onActionsUpdate);
    const outcome = useModel(model.getOutcome, model.onOutcomeUpdate);
    return (
      <div data-generated data-status={status.phase} className="flex flex-col gap-2">
        <p data-generated-status className="text-xs text-slate-500">
          {PHASE_TEXT[status.phase]}
        </p>
        {status.issues.length > 0 && (
          <ul role="alert" className="text-xs text-red-700">
            {status.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        {spec && (
          <GeneratedContext.Provider value={{ actions, model }}>
            <JSONUIProvider key={keyOf(model)} registry={components} store={model.store}>
              <Renderer spec={spec} registry={components} loading={status.phase === "streaming"} />
            </JSONUIProvider>
          </GeneratedContext.Provider>
        )}
        {outcome && (
          <p data-generated-outcome className="text-sm">
            {outcome}
          </p>
        )}
        <ActionButton action={model.close} />
      </div>
    );
  };
}
