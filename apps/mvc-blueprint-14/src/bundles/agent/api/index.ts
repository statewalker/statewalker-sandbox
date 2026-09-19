import {
  type ActionView,
  defineKeyedSlot,
  defineViewKind,
  type Listener,
  newAdapter,
  type Unsubscribe,
} from "@kernel";
import type { Spec, StateStore } from "@json-render/core";
import type { ZodType } from "zod";

/**
 * The agent API (J1): what a bundle needs to let an agent act for it, and the one generic view
 * kind a generated UI is published as. Declarations only.
 */

// ── what bundles contribute ──────────────────────────────────────────────────────────────────
/**
 * An agent-callable action: the allow-list IS this slot. A bundle contributes one entry per command
 * it lets a generated UI trigger; everything else — every other command, json-render's built-ins —
 * is refused at validation.
 */
export interface AgentAction<P = never> {
  /** What it does — this text goes into the LLM prompt. */
  readonly description: string;
  /** Params schema; the drain parses the captured params with it before `run`. */
  readonly params: ZodType<P>;
  /** Performs the effect through the contributing bundle's own API (an existing command). */
  run(params: P): Promise<unknown>;
}
/** `agent:actions` — keyed by action name (`todos.compose`). */
export const agentActionsSlot = defineKeyedSlot<AgentAction>("agent:actions");

/** Read-only application data a generated UI may show, at `/data/<key>`. Plain JSON. */
export interface AgentDataSource {
  readonly description: string;
  get(): unknown;
  on(listener: Listener): Unsubscribe;
}
/** `agent:data` — keyed by the name under `/data`. */
export const agentDataSlot = defineKeyedSlot<AgentDataSource>("agent:data");

// ── the generator (an LLM, or recorded fixtures) ─────────────────────────────────────────────
export interface GenerationRequest {
  /** The user's request. */
  readonly request: string;
  /** The system prompt generated from the aggregated catalog. */
  readonly system: string;
  /** The data the UI may read, as of the request. */
  readonly data: Readonly<Record<string, unknown>>;
}
/** Streams SpecStream text (JSONL of RFC 6902 patches) in arbitrary chunks. */
export interface SpecGenerator {
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<string>;
}
/** `agent:generator` — provided by `agent.fixtures` unless the host already set one. */
export const specGeneratorAdapter = newAdapter<SpecGenerator>("agent:generator");

// ── the generated view ───────────────────────────────────────────────────────────────────────
export type GeneratedPhase = "streaming" | "ready" | "invalid" | "error";
export interface GeneratedStatus {
  readonly phase: GeneratedPhase;
  /** Why a spec was refused (validation issues), or the generator's error. */
  readonly issues: readonly string[];
}
/** What json-render reads: the form group under `/form`, the data under `/data`. */
export interface GeneratedState {
  readonly form: Readonly<Record<string, unknown>>;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * The model of a generated UI — our three kinds, unchanged:
 * - presentation (controller-written): `spec` (the validated prefix while streaming), `status`,
 *   `data`, `actions`, `outcome`;
 * - form (view-written): `values`, through `editField` on a field the spec seeded;
 * - action: one `ActionView` per allow-listed action the spec binds, plus `close`.
 *
 * `store` is json-render's `StateStore` over the same groups — a facade, not a fourth writer:
 * `set("/form/<field>")` is `editField`; every other path is refused and logged.
 */
export interface GeneratedView {
  getSpec(): Spec | null;
  onSpecUpdate(listener: Listener): Unsubscribe;
  getStatus(): GeneratedStatus;
  onStatusUpdate(listener: Listener): Unsubscribe;
  getValues(): Readonly<Record<string, unknown>>;
  onValuesUpdate(listener: Listener): Unsubscribe;
  editField(field: string, value: unknown): void;
  getData(): Readonly<Record<string, unknown>>;
  onDataUpdate(listener: Listener): Unsubscribe;
  getActions(): Readonly<Record<string, ActionView>>;
  onActionsUpdate(listener: Listener): Unsubscribe;
  /** The last action's result or failure. */
  getOutcome(): string | undefined;
  onOutcomeUpdate(listener: Listener): Unsubscribe;
  readonly close: ActionView;
  readonly store: StateStore;
}

export const generatedKind = defineViewKind<GeneratedView>("jr:generated");
