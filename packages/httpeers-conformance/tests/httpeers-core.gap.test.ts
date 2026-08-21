import { describeConformance } from "../src/suite.js";
import { httpeersCoreImplementation } from "../adapters/httpeers-core.js";

describeConformance(httpeersCoreImplementation);
