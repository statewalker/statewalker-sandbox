import type { Catalog, ComponentDef } from "./catalog.js";
import { classesFor, dataVariantFor, partClass } from "./basecoat.js";

/**
 * The A2UI renderer. Consolidated from prototypes 2, 3, 6b and 7 — those
 * archives contain superseded copies; THIS is the live one.
 *
 * Rung 2 proved static structure renders against a catalogue.
 * Rung 3 added data binding and action dispatch, and fixed the focus defect
 * rung 2 created.
 * Rung 6b added the Basecoat mapping and surfaced the render-key bug.
 * Rung 7 corrected variants to `data-variant`.
 *
 * TWO MEASURED RULES KEEP FOCUS ALIVE (see reconcile()):
 *  1. Only call replaceChildren when the child list ACTUALLY differs.
 *     replaceChildren detaches and reattaches every child even when passed
 *     identical instances, and reattaching blurs. Element identity is
 *     necessary but not sufficient.
 *  2. Never write input.value when that input is document.activeElement.
 */

/** A property is either a literal or a binding to a data-model path. */
export type Binding = { readonly path: string };

export interface Component {
  readonly id: string;
  readonly component: string;
  readonly [prop: string]: unknown;
}

export interface ActionEvent {
  readonly surfaceId: string;
  readonly name: string;
  readonly context?: Record<string, unknown>;
  /** Snapshot of the surface's data model at the moment of the action. */
  readonly dataModel: Record<string, unknown>;
}

export interface DataModelChange {
  readonly surfaceId: string;
  readonly path: string;
  readonly value: unknown;
}

/** A2UI v0.9.1 message subset. */
export interface A2uiMessage {
  readonly version: string;
  readonly createSurface?: {
    readonly surfaceId: string;
    readonly catalogId: string;
    /** ACCEPTED AND IGNORED. Honouring a peer-supplied theme is a security
     *  question, not only a design one, and is unresolved. */
    readonly theme?: Record<string, unknown>;
  };
  readonly updateComponents?: {
    readonly surfaceId: string;
    readonly components: Component[];
  };
  readonly updateDataModel?: {
    readonly surfaceId: string;
    readonly path: string;
    readonly value: unknown;
  };
  readonly deleteSurface?: { readonly surfaceId: string };
}

export interface RendererOptions {
  /** Called when the user triggers a declared action. */
  onAction?(event: ActionEvent): void;
  /** Called ONLY for user-originated model changes, never server ones. */
  onDataModelChange?(change: DataModelChange): void;
}

export interface Renderer {
  handle(message: A2uiMessage): void;
  surfaces(): string[];
  dataModel(surfaceId: string): Record<string, unknown> | undefined;
}

interface Surface {
  readonly id: string;
  readonly components: Map<string, Component>;
  readonly host: HTMLElement;
  data: Record<string, unknown>;
  /** Rendered elements by component id — the basis of reconciliation. */
  readonly elements: Map<string, HTMLElement>;
}

function isBinding(v: unknown): v is Binding {
  return typeof v === "object" && v !== null && typeof (v as Binding).path === "string";
}

/** Read a JSON-pointer-ish path. Returns undefined rather than throwing. */
function readPath(data: unknown, path: string): unknown {
  const parts = path.split("/").filter(Boolean);
  let cur: unknown = data;
  for (const part of parts) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Write a path, creating intermediates, without clobbering siblings. */
function writePath(
  data: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) {
    return typeof value === "object" && value !== null
      ? { ...(value as Record<string, unknown>) }
      : data;
  }
  const next = { ...data };
  let cur: Record<string, unknown> = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    const existing = cur[key];
    const copy =
      typeof existing === "object" && existing !== null
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cur[key] = copy;
    cur = copy;
  }
  cur[parts[parts.length - 1] as string] = value;
  return next;
}

export function createRenderer(
  root: HTMLElement,
  catalog: Catalog,
  options: RendererOptions = {},
): Renderer {
  const surfaces = new Map<string, Surface>();

  function validate(c: Component): ComponentDef {
    const def = catalog.components[c.component];
    if (!def) {
      throw new Error(
        `Component "${c.component}" is not in catalogue ${catalog.catalogId}`,
      );
    }
    for (const [name, prop] of Object.entries(def.props)) {
      const value = c[name];
      if (value === undefined) {
        if (prop.required) {
          throw new Error(
            `Component "${c.id}" (${c.component}) is missing required property "${name}"`,
          );
        }
        continue;
      }
      // A binding may stand in for any scalar property, so enum and type
      // checks are skipped for path references — the value is not known
      // until render time. KNOWN HOLE: a binding may resolve to a value the
      // catalogue forbids.
      if (isBinding(value)) continue;
      if (prop.type === "enum" && prop.values && !prop.values.includes(String(value))) {
        throw new Error(
          `Property "${name}" on "${c.id}" must be one of ${prop.values.join(", ")}`,
        );
      }
      if (prop.type === "id[]" && !Array.isArray(value)) {
        throw new Error(`Property "${name}" on "${c.id}" must be a list of ids`);
      }
    }
    return def;
  }

  function childIds(c: Component, def: ComponentDef): string[] {
    if (def.childrenProp) {
      const v = c[def.childrenProp];
      return Array.isArray(v) ? (v as string[]) : [];
    }
    if (def.childProp) {
      const v = c[def.childProp];
      return typeof v === "string" ? [v] : [];
    }
    return [];
  }

  /** Resolve a bindable property against the surface's data model. */
  function resolve(surface: Surface, value: unknown): string {
    if (isBinding(value)) {
      const resolved = readPath(surface.data, value.path);
      return resolved === undefined || resolved === null ? "" : String(resolved);
    }
    return value === undefined || value === null ? "" : String(value);
  }

  /** Build the element for a component. Called once per id, then reused. */
  function build(surface: Surface, c: Component): HTMLElement {
    switch (c.component) {
      case "Text": {
        const variant = isBinding(c["variant"])
          ? "body"
          : ((c["variant"] as string) ?? "body");
        const tag =
          variant === "h1"
            ? "h1"
            : variant === "h2"
              ? "h2"
              : variant === "caption"
                ? "small"
                : "p";
        const el = document.createElement(tag);
        // Classes come from the MAPPING, never from the message.
        const cls = classesFor("Text", variant);
        if (cls) el.className = cls;
        return el;
      }
      case "Column":
      case "Row": {
        const el = document.createElement("div");
        el.setAttribute("data-layout", c.component.toLowerCase());
        const cls = classesFor(c.component);
        if (cls) el.className = cls;
        return el;
      }
      case "Divider":
        return document.createElement("hr");
      case "Button": {
        const el = document.createElement("button");
        el.type = "button";
        el.className = classesFor("Button");
        {
          const v = isBinding(c["variant"]) ? undefined : (c["variant"] as string);
          const dv = dataVariantFor("Button", v);
          if (dv) el.setAttribute("data-variant", dv);
        }
        el.addEventListener("click", () => {
          // Read the CURRENT component, not the one captured at build time:
          // the action may have been updated since.
          const current = surface.components.get(c.id);
          const action = current?.["action"] as
            | { event?: { name?: string; context?: Record<string, unknown> } }
            | undefined;
          const name = action?.event?.name;
          if (!name) return;
          try {
            options.onAction?.({
              surfaceId: surface.id,
              name,
              context: action?.event?.context,
              dataModel: surface.data,
            });
          } catch (err) {
            // A foreign surface must not break the shell by triggering a
            // handler that throws.
            console.error(`Action handler for "${name}" threw`, err);
          }
        });
        return el;
      }
      case "TextField": {
        const wrap = document.createElement("label");
        wrap.className = classesFor("TextField");
        const span = document.createElement("span");
        span.className = partClass("TextField", "label");
        const input = document.createElement("input");
        input.type = "text";
        input.className = partClass("TextField", "input");
        wrap.appendChild(span);
        wrap.appendChild(input);
        input.addEventListener("input", () => {
          const current = surface.components.get(c.id);
          const bound = current?.["value"];
          if (!isBinding(bound)) return;
          surface.data = writePath(surface.data, bound.path, input.value);
          // User-originated only. Server updates must NOT echo back or the
          // two sides loop.
          options.onDataModelChange?.({
            surfaceId: surface.id,
            path: bound.path,
            value: input.value,
          });
          paint(surface);
        });
        return wrap;
      }
      default:
        throw new Error(`No element factory for "${c.component}"`);
    }
  }

  /** Apply current property values to an existing element, in place. */
  function apply(surface: Surface, c: Component, el: HTMLElement): void {
    switch (c.component) {
      case "Text":
        // textContent, never innerHTML: a bound value may come from a peer.
        el.textContent = resolve(surface, c["text"]);
        break;
      case "Button": {
        if (c["variant"] && !isBinding(c["variant"])) {
          const dv = dataVariantFor("Button", String(c["variant"]));
          if (dv) el.setAttribute("data-variant", dv);
          else el.removeAttribute("data-variant");
        }
        const action = c["action"] as { event?: { name?: string } } | undefined;
        if (action?.event?.name) el.setAttribute("data-action", action.event.name);
        else el.removeAttribute("data-action");
        break;
      }
      case "TextField": {
        const span = el.querySelector("span") as HTMLElement;
        const input = el.querySelector("input") as HTMLInputElement;
        span.textContent = resolve(surface, c["label"]);
        if (c["placeholder"]) input.placeholder = resolve(surface, c["placeholder"]);
        // RULE 2: never overwrite the field the user is currently editing.
        if (document.activeElement !== input) {
          input.value = resolve(surface, c["value"]);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Reconcile one component into the DOM, reusing the cached element.
   *
   * This is what preserves focus: the element for a given component id is
   * built once and thereafter mutated, never replaced.
   */
  function reconcile(surface: Surface, id: string, seen: Set<string>): HTMLElement {
    if (seen.has(id)) throw new Error(`Component reference cycle through "${id}"`);
    const c = surface.components.get(id);
    if (!c) throw new Error(`Component "${id}" is referenced but missing`);
    const def = validate(c);

    // FOUND IN 6b: keying the cache on component TYPE alone is not enough.
    // Text's `variant` selects the TAG (h1 / h2 / p / small), so changing
    // variant at the same id must rebuild, not merely restyle. The render
    // key therefore includes any property that affects element identity.
    const renderKey =
      c.component === "Text"
        ? `Text:${isBinding(c["variant"]) ? "body" : ((c["variant"] as string) ?? "body")}`
        : c.component;

    let el = surface.elements.get(id);
    if (!el || el.getAttribute("data-render-key") !== renderKey) {
      el = build(surface, c);
      el.setAttribute("data-component", c.component);
      el.setAttribute("data-render-key", renderKey);
      surface.elements.set(id, el);
    }
    apply(surface, c, el);

    const kids = childIds(c, def);
    if (kids.length) {
      const next = new Set(seen);
      next.add(id);
      const built = kids.map((k) => reconcile(surface, k, next));
      // RULE 1, MEASURED: replaceChildren blurs the active element even when
      // passed the SAME element instances -- it detaches and reattaches each
      // node. So only touch the DOM when the child list has actually changed.
      const same =
        el.childNodes.length === built.length &&
        built.every((child, i) => el.childNodes[i] === child);
      if (!same) el.replaceChildren(...built);
    }
    return el;
  }

  function paint(surface: Surface): void {
    if (!surface.components.has("root")) {
      surface.host.replaceChildren();
      return;
    }
    const tree = reconcile(surface, "root", new Set());
    if (surface.host.firstChild !== tree) surface.host.replaceChildren(tree);
  }

  return {
    handle(message) {
      if (message.createSurface) {
        const { surfaceId, catalogId } = message.createSurface;
        if (catalogId !== catalog.catalogId) {
          throw new Error(
            `Unsupported catalog "${catalogId}"; this renderer implements ${catalog.catalogId}`,
          );
        }
        const host = document.createElement("div");
        host.setAttribute("data-surface", surfaceId);
        root.appendChild(host);
        surfaces.set(surfaceId, {
          id: surfaceId,
          components: new Map(),
          host,
          data: {},
          elements: new Map(),
        });
        return;
      }

      if (message.updateComponents) {
        const { surfaceId, components } = message.updateComponents;
        const surface = surfaces.get(surfaceId);
        if (!surface) throw new Error(`Unknown surface "${surfaceId}"`);
        // Validate the whole batch BEFORE mutating anything, so a bad batch
        // cannot leave a surface half-updated. Matters more here than in a
        // typical renderer: the batch may come from a peer.
        for (const c of components) validate(c);
        for (const c of components) surface.components.set(c.id, c);
        paint(surface);
        return;
      }

      if (message.updateDataModel) {
        const { surfaceId, path, value } = message.updateDataModel;
        const surface = surfaces.get(surfaceId);
        if (!surface) throw new Error(`Unknown surface "${surfaceId}"`);
        surface.data = writePath(surface.data, path, value);
        // Deliberately does NOT fire onDataModelChange: this came FROM the
        // server, and echoing it back would loop.
        paint(surface);
        return;
      }

      if (message.deleteSurface) {
        const surface = surfaces.get(message.deleteSurface.surfaceId);
        if (surface) {
          surface.host.remove();
          surfaces.delete(surface.id);
        }
        return;
      }
    },

    surfaces() {
      return [...surfaces.keys()];
    },

    dataModel(surfaceId) {
      return surfaces.get(surfaceId)?.data;
    },
  };
}
