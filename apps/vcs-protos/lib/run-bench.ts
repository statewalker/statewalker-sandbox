// Prints each prototype's throughput table (recorded in its README with date and Node version).
import { bench01 } from "../01-streaming-git-hash/bench.js";

const only = process.argv[2];
console.log(`Node ${process.version}, ${new Date().toISOString().slice(0, 10)}`);
if (!only || only === "01") console.log(`\n01-streaming-git-hash\n${await bench01()}`);
