/**
 * The relay process. Reads the environment, boots the relay, prints what it
 * became, and shuts down on a signal.
 *
 * This file is the only place `process.env`, `console` and `process.exit`
 * appear in this package. Everything else is a library that takes arguments
 * and returns values, which is why the failure paths an operator actually
 * meets -- the missing key, the malformed secret, the unparseable announce
 * address -- are reachable from a test instead of only from a terminal.
 */

import { RelayConfigError, resolveRelayConfig } from "./config.js";
import { isProcessEntry } from "./entry.js";
import { type Relay, startRelayFromConfig } from "./relay.js";
import { relayStartupReport } from "./report.js";

/**
 * Boots from `process.env` and prints the startup report. Returns the running
 * relay so a caller can stop it; exits 1, having printed the guidance, on any
 * `RelayConfigError`.
 */
export async function runRelay(): Promise<Relay> {
  let config: ReturnType<typeof resolveRelayConfig>;
  try {
    config = resolveRelayConfig(process.env);
  } catch (err) {
    if (err instanceof RelayConfigError) {
      // The message is already written for a terminal -- multi-line, naming
      // the variable at fault. Printing it verbatim is the point; a stack
      // trace here would bury it.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const relay = await startRelayFromConfig(config);
  const { lines, warnings } = relayStartupReport(
    config,
    relay.node.peerId.toString(),
    relay.node.getMultiaddrs().map((addr) => addr.toString()),
  );
  for (const line of lines) console.log(line);
  for (const warning of warnings) console.error(warning);
  return relay;
}

if (isProcessEntry(import.meta.url)) {
  const relay = await runRelay();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nrelay: received ${signal}, stopping...`);
    try {
      await relay.stop();
    } catch (err) {
      console.error("relay: error during stop:", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
