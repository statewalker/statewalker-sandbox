// Prints each prototype's throughput table (recorded in its README with date and Node version).
import { bench01 } from "../01-streaming-git-hash/bench.js";
import { bench02 } from "../02-inflate-stream-ends/bench.js";
import { bench03 } from "../03-sha256-blake3/bench.js";
import { bench04 } from "../04-pooled-inflater/bench.js";

const only = process.argv[2];
console.log(`Node ${process.version}, ${new Date().toISOString().slice(0, 10)}`);
if (!only || only === "01") console.log(`\n01-streaming-git-hash\n${await bench01()}`);
if (!only || only === "02") console.log(`\n02-inflate-stream-ends\n${await bench02()}`);
if (!only || only === "03") console.log(`\n03-sha256-blake3\n${await bench03()}`);
if (!only || only === "04") console.log(`\n04-pooled-inflater\n${await bench04()}`);
