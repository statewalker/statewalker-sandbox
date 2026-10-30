/** A local Service for the Bridge to relay to. */
import { createServer } from "node:http";

export interface Running {
  origin: string;
  close(): Promise<void>;
}

export async function startService(): Promise<Running> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "dirk", path: url.pathname }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
