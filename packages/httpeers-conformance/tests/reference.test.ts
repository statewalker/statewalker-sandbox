import { describeConformance } from "../src/suite.js";
import { referenceImplementation } from "../adapters/reference.js";

describeConformance(referenceImplementation);
