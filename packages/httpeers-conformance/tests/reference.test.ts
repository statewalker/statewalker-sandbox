import { referenceImplementation } from "../adapters/reference.js";
import { describeConformance } from "../src/suite.js";

describeConformance(referenceImplementation);
