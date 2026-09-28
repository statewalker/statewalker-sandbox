import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

export interface MeshStack {
  hubPeerId: string;
  outsideUrl: string;
  invitation(role: "admin" | "member"): Promise<string>;
  llmStats(): Promise<{ completions: number; lastModel: string | null }>;
  /** Everything the stack printed: the hub's and relay's own logs. */
  log(): string;
  stop(): Promise<void>;
}

// Playwright loads tests as CommonJS: `__dirname`, not `import.meta.url`.
const script = join(__dirname, "../../tools/mesh-stack.mjs");

/** Starts `tools/mesh-stack.mjs` and reads what it prints: the hub, the outside origin and its control URL. */
export function startMeshStack(appUrl: string): Promise<MeshStack> {
  const child: ChildProcess = spawn(process.execPath, [script, appUrl], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let started = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`mesh-stack did not start:\n${out}`)), 60_000);
    const fail = (error: Error) => {
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    child.on("exit", (code) => fail(new Error(`mesh-stack exited (${code}):\n${out}`)));
    child.stderr?.on("data", (d) => {
      out += d;
    });
    child.stdout?.on("data", (d) => {
      out += d;
      const field = (name: string) => new RegExp(`^${name}\\s+(\\S+)`, "m").exec(out)?.[1];
      const control = field("control");
      const hubPeerId = field("hub");
      const outsideUrl = field("outside");
      if (started || control == null || hubPeerId == null || outsideUrl == null) return;
      started = true;
      clearTimeout(timer);
      child.removeAllListeners("exit");
      const get = async (path: string) => {
        const res = await fetch(`${control}${path}`);
        if (!res.ok) throw new Error(`mesh-stack ${path}: ${res.status} ${await res.text()}`);
        return res.text();
      };
      resolve({
        hubPeerId,
        outsideUrl,
        invitation: (role) => get(`/invite?role=${role}`),
        llmStats: async () => JSON.parse(await get("/stats")),
        // A libp2p stop can hang on a peer that is still connected; it gets a few seconds.
        log: () => out,
        stop: () =>
          new Promise<void>((done) => {
            if (child.exitCode != null || child.signalCode != null) {
              done();
              return;
            }
            const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
            child.once("exit", () => {
              clearTimeout(kill);
              done();
            });
            child.kill("SIGTERM");
          }),
      });
    });
  });
}
