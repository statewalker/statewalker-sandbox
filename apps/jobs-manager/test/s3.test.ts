import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJobManager,
  discoverTasks,
  type JobMessage,
  type ProcessJobManager,
} from "../src/index.ts";
import {
  collect,
  encodePpm,
  makePpm,
  parsePpm,
  resizeNearest,
  SCHEMAS_DIR,
  tempDir,
} from "./helpers.ts";

/**
 * A stand-in for S3: objects in memory, every request authorised by a presigned query
 * (`expires`, `sig` = HMAC of method, key and expiry), so a URL signed for PUT cannot GET or
 * DELETE, and an expired URL is refused, as with real presigned URLs.
 */
class ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly #secret = "test-secret";
  #server!: Server;
  url = "";

  async start() {
    this.#server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", this.url);
      const method = req.method ?? "GET";
      const expires = Number(url.searchParams.get("expires"));
      if (url.searchParams.get("sig") !== this.#sign(method, url.pathname, expires)) {
        res.writeHead(403).end("SignatureDoesNotMatch");
        return;
      }
      if (expires < Date.now() / 1000) {
        res.writeHead(403).end("Request has expired");
        return;
      }
      if (method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        this.objects.set(url.pathname, new Uint8Array(Buffer.concat(chunks)));
        res.writeHead(200).end();
      } else if (method === "GET") {
        const object = this.objects.get(url.pathname);
        if (object) res.writeHead(200, { "content-type": "image/x-portable-pixmap" }).end(object);
        else res.writeHead(404).end("NoSuchKey");
      } else if (method === "DELETE") {
        this.objects.delete(url.pathname);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  /** A presigned URL for one method on one key, valid for `ttlSeconds` (negative: already expired). */
  presign(method: string, key: string, ttlSeconds = 300): string {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `${this.url}${key}?expires=${expires}&sig=${this.#sign(method, key, expires)}`;
  }

  #sign(method: string, key: string, expires: number): string {
    return createHmac("sha256", this.#secret).update(`${method}\n${key}\n${expires}`).digest("hex");
  }

  close() {
    this.#server.close();
  }
}

let dir: Awaited<ReturnType<typeof tempDir>>;
let manager: ProcessJobManager;
let store: ObjectStore;
const IMAGE = makePpm(30, 20);

beforeEach(async () => {
  dir = await tempDir();
  store = new ObjectStore();
  await store.start();
  manager = await createJobManager({
    root: join(dir.path, "jobs"),
    tasks: await discoverTasks(SCHEMAS_DIR),
  });
});

afterEach(async () => {
  await manager.close();
  store.close();
  await dir.remove();
});

/** The params a client sends: per result, presigned upload, read and delete URLs. */
function targets(prefix: string, sizes: number[], deleteTtl = 300) {
  return sizes.map((size) => {
    const key = `/bucket/${prefix}/${size}.ppm`;
    return {
      size,
      uploadUrl: store.presign("PUT", key),
      readUrl: store.presign("GET", key),
      deleteUrl: store.presign("DELETE", key, deleteTtl),
    };
  });
}

const results = (messages: JobMessage[]) =>
  messages.flatMap((m) =>
    "message" in m && m.message ? [m.message as { size: number; url: string }] : [],
  );

describe("results stored with presigned URLs", () => {
  it("uploads each result, reports the read URL, and the cleanup deletes them", async () => {
    const params = { targets: targets("job1", [12, 6]) };
    const id = await manager.start("resize-s3", params, [IMAGE]);
    const messages = await collect(manager.logs(id));
    expect(messages.at(-1)?.status).toBe("done");

    const out = results(messages);
    expect(out.map((r) => r.url)).toEqual(params.targets.map((t) => t.readUrl));
    for (const r of out) {
      const response = await fetch(r.url);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        encodePpm(resizeNearest(parsePpm(IMAGE), r.size)),
      );
    }

    expect(await manager.cleanup()).toEqual({ removed: [id], failed: [] });
    expect(store.objects.size).toBe(0);
  });

  it("a presigned PUT URL can neither read nor delete", async () => {
    const [target] = targets("job2", [6]);
    await collect(manager.logs(await manager.start("resize-s3", { targets: [target] }, [IMAGE])));
    expect((await fetch(target!.uploadUrl, { method: "DELETE" })).status).toBe(403);
    expect((await fetch(target!.uploadUrl)).status).toBe(403);
    expect(store.objects.size).toBe(1);
  });

  it("an expired delete URL fails the cleanup: the job and its objects stay, with the 403 in failed", async () => {
    const params = { targets: targets("job3", [6], -1) };
    const id = await manager.start("resize-s3", params, [IMAGE]);
    await collect(manager.logs(id));
    const result = await manager.cleanup();
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([{ id, error: expect.stringContaining("403") }]);
    expect(await manager.status(id)).toBe("done");
    expect(store.objects.size).toBe(1);
  });
});
