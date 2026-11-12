/**
 * X17b — X17's folder sync over a network transport. Each endpoint serves its repository as a
 * `FetchHandler` (git's smart HTTP: upload-pack and receive-pack, X8a/X8b); another endpoint syncs
 * with it by fetching its `main`, merging with X17's deterministic merge, and pushing the result
 * back — refused as a non-fast-forward if the remote moved meanwhile, and then done again. A
 * watcher polls the folder and syncs on change, debounced. Nothing here knows the transport: a
 * peer is a URL and a `fetch` (httpeers' bridge, a WebSocket, plain HTTP).
 */

import type { FilesApi } from "@statewalker/webrun-files";
import { fetchFrom } from "../../21-smart-http/src/client.js";
import { push } from "../../22-receive-pack/src/client.js";
import { gitHandler } from "../../22-receive-pack/src/server.js";
import {
  commitFolder,
  type Endpoint,
  headOf,
  mergeInto,
} from "../../38-workspace-sync/src/workspace.js";

/** Another endpoint, reached through a transport. */
export interface Peer {
  /** names the remote-tracking ref (`refs/remotes/<name>/main`) */
  name: string;
  /** the repository's URL, as the peer's `serveEndpoint` answers it */
  url: string;
  fetch: typeof fetch;
}

// ---- one queue per endpoint: its own commits, merges and checkouts never interleave
const queues = new WeakMap<Endpoint, Promise<unknown>>();
function run<T>(ep: Endpoint, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(ep) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(
    ep,
    next.catch(() => undefined),
  );
  return next;
}
/** Resolves once everything queued on `ep` (syncs, refreshes after pushes) has run. */
export async function idle(ep: Endpoint): Promise<void> {
  for (let q = queues.get(ep); q; ) {
    await q;
    const now = queues.get(ep);
    if (now === q) return;
    q = now;
  }
}

/** `commitFolder`, again if an incoming push moved `main` meanwhile (its compare-and-swap failed). */
async function commitFolderSettled(ep: Endpoint): Promise<string | undefined> {
  for (let i = 0; ; i++) {
    try {
      return await commitFolder(ep);
    } catch (err) {
      if (i >= 8 || !/moved/.test(String((err as Error)?.message))) throw err;
    }
  }
}

/**
 * The endpoint's repository as a `FetchHandler`. A push that arrives updates `main` (receive-pack's
 * compare-and-swap) and, once its response has been sent, queues a refresh that checks the folder
 * out at the new head (X17's checkout keeps edits typed meanwhile). The response does not wait for
 * the refresh: two endpoints pushing to each other while each syncs would otherwise wait on each
 * other's queues.
 */
export function serveEndpoint(ep: Endpoint): (req: Request) => Promise<Response> {
  const handler = gitHandler(ep.repo);
  const refresh = () => void run(ep, () => commitFolderSettled(ep)).catch(() => undefined);
  return async (req) => {
    const res = await handler(req);
    const isPush = req.method === "POST" && new URL(req.url).pathname.endsWith("/git-receive-pack");
    if (!isPush) return res;
    if (!res.body) {
      refresh();
      return res;
    }
    const reader = res.body.getReader();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      refresh();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const r = await reader.read();
        if (r.done) {
          c.close();
          finish();
        } else c.enqueue(r.value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
        finish();
      },
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

export interface SyncResult {
  /** the head both ends hold afterwards */
  head: string;
  /** paths committed with conflict markers */
  conflicts: string[];
  /** fetch-merge-push rounds it took (more than one when the remote moved meanwhile) */
  attempts: number;
}

/** A push refused because the remote moved since the fetch: fetch, merge and push again. */
const LOST_RACE = /non-fast-forward|fetch first|failed to update|stale|changed|lock/;

/**
 * Brings `ep` and `peer` to one commit: commits the folder, fetches the peer's `main`, merges it
 * (X17's deterministic merge, checked out into the folder), and pushes the result, never forced.
 * A push the remote refuses because it moved meanwhile starts the round again, up to
 * `maxAttempts`. A failure of the transport rejects; nothing is left half-done that a later sync
 * cannot finish (objects arrive before refs move, on both sides).
 */
export async function syncWith(
  ep: Endpoint,
  peer: Peer,
  o: { maxAttempts?: number; beforePush?: () => Promise<void>; signal?: AbortSignal } = {},
): Promise<SyncResult> {
  const maxAttempts = o.maxAttempts ?? 8;
  const tracking = `refs/remotes/${peer.name}/main`;
  return run(ep, async () => {
    for (let attempts = 1; attempts <= maxAttempts; attempts++) {
      await commitFolderSettled(ep);
      await fetchFrom(peer.url, ep.repo, {
        fetch: peer.fetch,
        refspecs: [`+refs/heads/main:${tracking}`],
        followTags: false,
        signal: o.signal,
      });
      const theirs = await ep.repo.refs.resolve(tracking);
      const conflicts = theirs ? await mergeInto(ep, theirs) : [];
      const head = await headOf(ep);
      if (!head || head === theirs) return { head: head ?? "", conflicts, attempts };
      await o.beforePush?.();
      const results = await push(peer.url, ep.repo, {
        fetch: peer.fetch,
        refspecs: ["refs/heads/main:refs/heads/main"],
        signal: o.signal,
      });
      const r = results.find((x) => x.ref === "refs/heads/main");
      if (r?.ok) return { head, conflicts, attempts };
      if (!r || !LOST_RACE.test(r.reason ?? "")) {
        throw new Error(`push to ${peer.name} refused: ${r?.reason ?? "no report"}`);
      }
    }
    throw new Error(`no agreement with ${peer.name} after ${maxAttempts} attempts`);
  });
}

export interface WatchOptions {
  /** how often the folder is looked at (default 500 ms) */
  pollMs?: number;
  /** quiet time after the last change before syncing (default 300 ms) */
  debounceMs?: number;
  /** also sync this often with no local change, to pick up the peers' (default: never) */
  syncEveryMs?: number;
  /** after each round of syncs */
  onSync?: () => void;
  /** a peer that could not be reached; the next round tries again */
  onError?: (err: unknown, peer: Peer) => void;
}

/** what the poll compares: every file's path, size and modification time */
async function snapshot(folder: FilesApi): Promise<string> {
  const rows: string[] = [];
  for await (const e of folder.list("/", { recursive: true })) {
    if (e.kind === "file") rows.push(`${e.path}\0${e.size}\0${e.lastModified}`);
  }
  return rows.sort().join("\n");
}

/**
 * Keeps `ep` in step with `peers` without anyone calling `syncWith`: the folder is polled (a
 * FilesApi offers no change events everywhere, so polling is the portable floor), and a change
 * syncs with every peer once the folder has been quiet for `debounceMs`. A change made during a
 * round syncs again after it. Starting counts as a change: the folder is synced once at the start. `stop()` ends the watching and waits for a round in progress.
 *
 * The poll sees what `size` and `lastModified` show: a rewrite of the same size within one tick of
 * the clock passes unseen until the next change (or the next `syncEveryMs` round, which commits
 * the folder whatever it shows).
 */
export function watchEndpoint(
  ep: Endpoint,
  peers: Peer[],
  o: WatchOptions = {},
): { stop(): Promise<void>; idle(): Promise<void> } {
  const pollMs = o.pollMs ?? 500;
  const debounceMs = o.debounceMs ?? 300;
  let stopped = false;
  let seen: string | undefined;
  let changedAt = 0;
  // a watcher starts with one sync: what changed before its first look is a change too
  let dirty = true;
  let round: Promise<void> | undefined;
  let lastRound = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const syncAll = async () => {
    for (const peer of peers) {
      try {
        await syncWith(ep, peer);
      } catch (err) {
        o.onError?.(err, peer);
      }
    }
    lastRound = Date.now();
    o.onSync?.();
  };
  const tick = async () => {
    timer = undefined;
    if (stopped) return;
    try {
      const now = await snapshot(ep.folder);
      if (seen !== undefined && now !== seen) {
        dirty = true;
        changedAt = Date.now();
      }
      seen = now;
      const due =
        (dirty && Date.now() - changedAt >= debounceMs) ||
        (o.syncEveryMs !== undefined && Date.now() - lastRound >= o.syncEveryMs);
      if (due && !round) {
        dirty = false;
        round = syncAll().finally(() => {
          round = undefined;
        });
        // `seen` stays what it was before the round: a change made during it (after the round
        // committed the folder) shows on the next look and syncs again. What the round itself
        // checked out shows too, and costs one more round that finds nothing to send.
        await round;
      }
    } catch {
      // a folder that cannot be listed this tick is looked at again on the next
    }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };
  timer = setTimeout(tick, 0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await round;
    },
    /** resolves once no change is pending and no round is running */
    async idle() {
      for (;;) {
        await round;
        await new Promise((r) => setTimeout(r, pollMs * 2));
        if (!round && !dirty) return;
      }
    },
  };
}
