# 03 — Deny by default, roles bound to the proven peer

`pnpm demo:03-access-control`

Runs against the **real shipped packages**. Three real libp2p nodes: one
server, two clients with distinct generated identities.

## Verified

A six-request matrix across two callers and three resources:

| # | Caller | Path | Expected | Establishes |
|---|---|---|---|---|
| 1 | alice (`std:reader`) | `/public` | **200** | A resource requiring no role is reachable by any member |
| 2 | alice | `/reports` | **200** | A held role grants access to a resource requiring it |
| 3 | alice | `/admin` | **403** | Holding *a* role does not grant *every* role — no privilege creep |
| 4 | mallory (no roles) | `/public` | **200** | The open resource is genuinely open, so 5 and 6 are not just "mallory is blocked from everything" |
| 5 | mallory | `/reports` | **403** | A missing role is refused |
| 6 | mallory | `/admin` + forged header | **403** | **A forged `x-i-am-admin: true` header changes nothing** |

Additional properties:

| # | Claim | How it is established |
|---|---|---|
| 7 | Roles are looked up by the **proven** peer id | `roles.get(context.remotePeer.toString())` — the caller never sends its id |
| 8 | The forged header is genuinely *received*, just not *trusted* | The server echoes `claimedHeader` back; the demo prints it, showing it arrived and was ignored |
| 9 | Deny by default for unknown resources | A path absent from the policy returns 404 rather than falling open |
| 10 | The provider holds **no per-peer capability table** | Its entire state is a policy map plus a role map — no session store, no per-peer grants |

Exit code is 0 only if all six statuses match exactly.

## Not covered here

- **This is a flat policy map, not the walked `.access` tree** — see 07 for
  root→leaf resolution with inheritance, explicit deny, and explainable
  decisions.
- **No tokens.** Roles are a local map keyed by peer id. In the real design
  roles arrive in a hub-signed JWT; minting, signing and expiry are not here.
  See 08 for what happens when a role is revoked.
- **No capability layer.** Roles map straight to allow/deny; the role →
  capability union is 09.
- **Single mesh.** Cross-mesh trust — where an admin of another mesh gets
  nothing — is exercised in 07.
