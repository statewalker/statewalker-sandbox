# Guests view each Service in its own isolated origin

A shared Service is a web app: its responses are code. The HTTPeers security model
(`httpeers/docs/security-model.md`) says data crosses safely, code does not — a
same-origin iframe on the PeerShare page could read the Guest's identity key and
storage. So the Viewer frames each Service through `session-shell`'s `openSession`,
which gives it a fresh `<random>.p.httpeers.net` origin answered by a ServiceWorker
that forwards to the Sharer.

We rejected the edge path `/peers/<id>/…` on the PeerShare origin (same origin as
the key) and `createGateway` plain HTTP for browsers (no per-Guest authentication on
a public URL). The gateway stays available for non-browser consumers.

## Consequences

- The session domain is a config value: prototypes use `*.p.httpeers.net`; moving to
  `*.p.sandclaw.ai` is a deploy change only.
- The Service is served at the root of its origin, so absolute paths work without
  rewriting.
- A ServiceWorker cannot set cookies from responses it builds, and cannot answer
  WebSocket upgrades. v1 accepts both limits and the Probe warns about them; a
  per-Guest cookie jar and a WebSocket tunnel are separate prototypes.
