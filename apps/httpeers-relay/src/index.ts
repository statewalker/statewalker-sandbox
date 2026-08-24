/**
 * The relay as a library. `apps/httpeers-stack` imports `startRelay` from
 * here to boot a relay inside its own test suites and its own `pnpm start`,
 * rather than keeping a second copy of a component that is now deployable on
 * its own.
 */

export {
  DEFAULT_RELAY_KEY_PATH,
  DEFAULT_RELAY_PORT,
  loadRelayKey,
  RelayConfigError,
  type RelayEnv,
  type RelayTlsMaterial,
  type RelayTlsMode,
  resolveRelayConfig,
  type ResolvedRelayConfig,
} from "./config.js";
export { generateRelayIdentity } from "./keygen.js";
export { type Relay, startRelay, startRelayFromConfig, type StartRelayInit } from "./relay.js";
export { relayStartupReport, type RelayStartupReport } from "./report.js";
