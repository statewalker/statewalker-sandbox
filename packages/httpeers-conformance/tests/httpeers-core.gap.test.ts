import { httpeersCoreImplementation } from "../adapters/httpeers-core.js";
import { describeConformance } from "../src/suite.js";

describeConformance(httpeersCoreImplementation);
