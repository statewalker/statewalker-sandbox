/**
 * The relay as a library. `apps/httpeers-stack` imports `startRelay` from
 * here to boot a relay inside its own test suites and its own `pnpm start`,
 * rather than keeping a second copy of a component that is now deployable on
 * its own.
 */

export {
  DEFAULT_RELAY_HTTP_PORT,
  DEFAULT_RELAY_KEY_PATH,
  DEFAULT_RELAY_LIMITS,
  DEFAULT_RELAY_PORT,
  loadRelayKey,
  RelayConfigError,
  type RelayEnv,
  type RelayLimits,
  type RelayMode,
  type RelayNetworkDescriptor,
  type RelayTlsMaterial,
  type RelayTlsMode,
  type ResolvedRelayConfig,
  resolveRelayConfig,
} from "./config.js";
export {
  DISCOVERY_PATH,
  HEALTH_PATH,
  type RelayDiscoveryDocument,
  type RelayHttp,
  type RelayHttpInit,
  startRelayHttp,
} from "./http.js";
export { generateRelayIdentity } from "./keygen.js";
export { type Relay, type StartRelayInit, startRelay, startRelayFromConfig } from "./relay.js";
export { type RelayStartupReport, relayStartupReport } from "./report.js";
export { SMOKE_SUBNETWORK, type SmokeInit, type SmokeResult, smokeTest } from "./smoke.js";
/**
 * The subnetwork protocol, shared by both ends. A BROWSER PAGE SHOULD IMPORT
 * `@statewalker/httpeers-relay/subnetwork` DIRECTLY rather than this barrel:
 * everything else exported here reaches `node:fs` through `./config.js`.
 */
export {
  type AnnounceSubnetworkInit,
  announceSubnetwork,
  isValidSubnetworkName,
  MAX_SUBNETWORK_NAME_LENGTH,
  RELAY_NET_PROTOCOL,
  type SubnetworkAnnouncement,
  type SubnetworkAnnouncementReply,
  type SubnetworkRefusalReason,
  SubnetworkRefusedError,
  subnetworkNameProblem,
} from "./subnetwork.js";
export {
  createSubnetworkRegistry,
  DEFAULT_ADMISSION_GRACE_MS,
  type SubnetworkRegistry,
  type SubnetworkRegistryInit,
} from "./subnetwork-registry.js";
