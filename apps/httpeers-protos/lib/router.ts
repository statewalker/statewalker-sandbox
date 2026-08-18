/**
 * The L2 router: `/{peerId}/{path}` in, a Response out.
 *
 * Two findings are baked in here.
 *
 * R-1 — mount matching is longest-prefix **on segment boundaries**. Without
 * the boundary rule, a mount at `/files` also swallows `/filesystem`, which is
 * the kind of thing that looks fine until someone mounts a name that happens
 * to share a prefix.
 *
 * R-2 — the router forwards requests addressed to *other* peers. In the
 * original, access was enforced only on the local branch, so any peer could
 * ask any other peer to relay to a third party: an open relay. It was
 * invisible because it failed closed at the far end — the response looked
 * right, but the work had been done for a stranger. Forwarding is therefore
 * deny-by-default and gets its own policy hook.
 */

export type Handler = (request: Request) => Promise<Response>;

export interface Mount {
  prefix: string;
  handler: Handler;
}

export interface RouterInit {
  selfPeerId: string;
  mounts: Mount[];
  /** Dial another peer. Only reached once `allowForward` says yes. */
  remote?: (peerId: string, request: Request) => Promise<Response>;
  /** Deny by default: absent means "never forward". */
  allowForward?: (request: Request, target: string, from: string) => Promise<boolean>;
}

/** Normalise so `/a`, `/a/` and `a` compare the same way. */
const norm = (p: string): string => {
  const s = p.startsWith("/") ? p : `/${p}`;
  return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
};

/** Longest prefix wins, but only on a segment boundary. */
export function matchMount(mounts: Mount[], path: string): Mount | undefined {
  const target = norm(path);
  let best: Mount | undefined;
  for (const m of mounts) {
    const p = norm(m.prefix);
    const hit = p === "/" || target === p || target.startsWith(`${p}/`);
    if (!hit) continue;
    if (best === undefined || norm(p).length > norm(best.prefix).length) best = m;
  }
  return best;
}

export function createRouter(init: RouterInit) {
  const { selfPeerId, mounts, remote, allowForward } = init;

  return async function route(request: Request, provenPeer: string): Promise<Response> {
    const url = new URL(request.url);
    const [, addressed = "", ...rest] = url.pathname.split("/");

    if (addressed !== selfPeerId) {
      // Addressed to someone else — this is the forwarding path.
      if (allowForward === undefined || remote === undefined) {
        return Response.json(
          { error: "forwarding not permitted", target: addressed, from: provenPeer },
          { status: 403 },
        );
      }
      if (!(await allowForward(request, addressed, provenPeer))) {
        return Response.json(
          { error: "forwarding refused by policy", target: addressed, from: provenPeer },
          { status: 403 },
        );
      }
      return remote(addressed, request);
    }

    const path = `/${rest.join("/")}`;
    const mount = matchMount(mounts, path);
    if (mount === undefined) return Response.json({ error: "no mount", path }, { status: 404 });
    return mount.handler(request);
  };
}
