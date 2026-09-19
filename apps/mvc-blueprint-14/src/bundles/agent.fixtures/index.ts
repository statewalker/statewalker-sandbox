import { type SpecGenerator, specGeneratorAdapter } from "@b/agent/api";
import { type Controller, getConfig, isProvided } from "@kernel";
import { DEFAULT_FIXTURES } from "./fixtures.js";

/** `sys:config` key: milliseconds between replayed chunks (default 40, so streaming is visible). */
export const FIXTURE_DELAY_KEY = "agent:fixture-delay-ms";

/**
 * Replays recorded JSONL, a line at a time in two chunks (so the compiler sees partial lines),
 * stopping at once when the signal aborts.
 */
export function replay(fixtures: Readonly<Record<string, string>>, delayMs: number): SpecGenerator {
  return {
    async *generate(request, signal) {
      const text = fixtures[request.request];
      if (text === undefined) throw new Error(`no recorded response for "${request.request}"`);
      for (const line of text.split("\n")) {
        const half = Math.ceil(line.length / 2);
        for (const chunk of [line.slice(0, half), `${line.slice(half)}\n`]) {
          await new Promise((r) => setTimeout(r, delayMs));
          if (signal.aborted) return;
          yield chunk;
        }
      }
    },
  };
}

/** `agent.fixtures`: provides `agent:generator` (recorded responses) unless the host set one. */
export const activate: Controller = async (context) => {
  if (isProvided(context, specGeneratorAdapter.key)) return;
  const delay = Number(getConfig(context)[FIXTURE_DELAY_KEY] ?? 40);
  specGeneratorAdapter.set(context, replay(DEFAULT_FIXTURES, delay));
};
