// The Node engine's file thread: takes the SDK's blocking host-filesystem requests (from the
// engine's main thread and its SDK worker threads), sends each to the Agent cell over the pipe
// on fd 4 as a JSON line, reads the reply line from fd 5, and answers into the request's shared
// buffer. Synchronous on purpose: the thread that asked is blocked until the reply is there,
// and this thread needs no event loop turn to deliver it. One request at a time, in order.
import { readSync, writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const { respondToHostFileSystem } = await import(workerData.bridge);
const REQUESTS = 4;
const REPLIES = 5;

const toWire = (v) => {
  if (v instanceof Uint8Array)
    return { $b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  if (Array.isArray(v)) return v.map(toWire);
  return v;
};
const fromWire = (v) => {
  if (v && typeof v === "object" && typeof v.$b64 === "string")
    return new Uint8Array(Buffer.from(v.$b64, "base64"));
  if (Array.isArray(v)) return v.map(fromWire);
  return v;
};

let pending = Buffer.alloc(0);
const chunk = Buffer.alloc(64 * 1024);
const sleep = new Int32Array(new SharedArrayBuffer(4));
function readLine() {
  for (;;) {
    const nl = pending.indexOf(10);
    if (nl >= 0) {
      const line = pending.subarray(0, nl).toString("utf8");
      pending = pending.subarray(nl + 1);
      return line;
    }
    let n;
    try {
      n = readSync(REPLIES, chunk, 0, chunk.length, null);
    } catch (e) {
      if (e.code === "EAGAIN") {
        Atomics.wait(sleep, 0, 0, 2);
        continue;
      }
      throw e;
    }
    if (n === 0)
      throw Object.assign(new Error("the Agent closed the file channel"), { code: "EIO" });
    pending = Buffer.concat([pending, chunk.subarray(0, n)]);
  }
}
function writeLine(text) {
  const buf = Buffer.from(`${text}\n`);
  let at = 0;
  while (at < buf.length) {
    try {
      at += writeSync(REQUESTS, buf, at);
    } catch (e) {
      if (e.code !== "EAGAIN") throw e;
      Atomics.wait(sleep, 0, 0, 2);
    }
  }
}

parentPort.on("message", (req) => {
  let reply;
  try {
    writeLine(JSON.stringify({ mount: req.mount, method: req.method, args: toWire(req.args) }));
    const r = JSON.parse(readLine());
    reply = r.error ? { error: r.error } : { value: fromWire(r.value) };
  } catch (e) {
    reply = { error: { code: e.code ?? "EIO", message: String(e.message ?? e) } };
  }
  respondToHostFileSystem(req, reply);
});
