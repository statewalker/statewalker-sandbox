import type { GeneratedView, GenerationRequest, SpecGenerator } from "@b/agent/api";
import type { ApplicationManifest, CommandDeclaration, KernelCommands } from "@kernel";
import {
  agentContacts,
  agentFeature,
  agentTodos,
  uiBadge,
  uiCatalog,
} from "../../src/features/agent.js";
import { agentReact, uiBadgeReact, uiCatalogReact } from "../../src/features/agent.react.js";
import { menuItem, panel, type Running, until, workbenchHeadless } from "./harness.js";

/** P0's headless workbench plus every J1 feature. */
export const agentHeadless: ApplicationManifest = {
  id: "workbench.agent.headless",
  features: [
    ...workbenchHeadless.features,
    uiCatalog,
    uiCatalogReact,
    uiBadge,
    uiBadgeReact,
    agentFeature,
    agentReact,
    agentTodos,
    agentContacts,
  ],
};

/** Serialises patches as a model would stream them. */
export const jsonl = (...patches: object[]) => patches.map((p) => `${JSON.stringify(p)}\n`);
export const add = (path: string, value: unknown) => ({ op: "add", path, value });
export const el = (type: string, props: object, extra: object = {}) => ({
  type,
  props,
  children: [],
  ...extra,
});

/**
 * A generator the test drives chunk by chunk. It deliberately IGNORES the abort signal (a
 * misbehaving generator): whatever it yields after a close must still write nothing.
 */
export function controlledGenerator() {
  const queue: string[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const requests: GenerationRequest[] = [];
  const signals: AbortSignal[] = [];
  const generator: SpecGenerator = {
    async *generate(request, signal) {
      requests.push(request);
      signals.push(signal);
      while (true) {
        while (queue.length > 0) yield queue.shift() as string;
        if (ended) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
  const kick = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  return {
    generator,
    requests,
    signals,
    push(...chunks: string[]) {
      queue.push(...chunks);
      kick();
    },
    end() {
      ended = true;
      kick();
    },
  };
}

/** A generator that replays one recorded text at once (the whole stream is known). */
export function fixedGenerator(text: string | readonly string[]): SpecGenerator {
  const chunks = typeof text === "string" ? [text] : text;
  return {
    async *generate() {
      for (const c of chunks) {
        await Promise.resolve();
        yield c;
      }
    },
  };
}

export const assistant = (r: Running) => panel<GeneratedView>(r.slots, "agent:assistant")?.model;

/** Opens the Assistant and waits for its panel. */
export async function openAssistant(r: Running): Promise<GeneratedView> {
  menuItem(r.slots, "Assistant…").submit();
  await until(() => assistant(r) !== undefined);
  return assistant(r) as GeneratedView;
}

/** Records every command call (the agent's bundles call through the shared bus). */
export function spyCommands(commands: KernelCommands) {
  const calls: { key: string; payload: unknown }[] = [];
  const original = commands.call.bind(commands);
  commands.call = (<P, R>(decl: CommandDeclaration<P, R>, payload: P) => {
    calls.push({ key: decl.key, payload });
    return original(decl, payload);
  }) as KernelCommands["call"];
  return calls;
}
