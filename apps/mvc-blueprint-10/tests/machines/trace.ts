import { type Chart, type Handlers, type Machine, startMachine } from "@kit/machine";
import { newRecordingLogger } from "../support/logging.js";

/** Starts a chart with a recording handler on every state: `+key(event)` on enter, `-key` on exit. */
export async function trace(chart: Chart): Promise<{ machine: Machine; log: string[] }> {
  const log: string[] = [];
  const handlers: Record<string, Handlers[string]> = {};
  const visit = (c: Chart) => {
    handlers[c.key] = ({ event }) => {
      log.push(`+${c.key}${event ? `(${event})` : ""}`);
      return () => log.push(`-${c.key}`);
    };
    for (const s of c.states ?? []) visit(s);
  };
  visit(chart);
  const machine = startMachine(chart, handlers, {
    log: newRecordingLogger().logger,
    name: chart.key,
  });
  await machine.idle();
  return { machine, log };
}

/** Sends events one by one; returns the leaf after each. */
export async function drive(machine: Machine, ...events: string[]): Promise<string[]> {
  const leaves: string[] = [];
  for (const e of events) {
    machine.send(e);
    await machine.idle();
    leaves.push(machine.states().join("/"));
  }
  return leaves;
}
