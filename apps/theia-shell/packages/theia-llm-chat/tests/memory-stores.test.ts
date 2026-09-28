import { memoryConfigStore } from "../src/common/core/config.js";
import { memorySessionStore } from "../src/common/core/sessions.js";
import { describeConfigStoreContract } from "./contracts/config-store.contract.js";
import { describeSessionStoreContract } from "./contracts/session-store.contract.js";

describeSessionStoreContract("memory", (clock) => memorySessionStore(clock));
describeConfigStoreContract("memory", () => memoryConfigStore());
