# 16 (spike) — Can a jar per Guest keep cookie logins working?

`pnpm test 16-cookie-jar`

**Answer: yes, for Bridged Services, with the jar in the Bridge.** Rung 04 found that only
the Bridge can see `Set-Cookie`, so the jar lives there, one per Guest. The Sharer names the
Guest on every request from the peer id the **mesh proved**, never from what the Guest sent.

```ts
createBridge({ …, cookieJars: true })   // a Service's Set-Cookie → that Guest's jar → their next requests
stampGuest(serviceTable(…))             // the Sharer: x-peershare-guest = lookupPeer(request)
```

## Measured, 2026-10-30

- At the Bridge: Claudia's login cookie is sent on Claudia's next request, never on Marta's.
- Over the real mesh, with two real Guests: Claudia logs in and stays logged in, and Marta
  does not inherit it.
- Marta sending `x-peershare-guest: <Claudia's peer id>` herself still gets her own empty
  jar: the Sharer overwrites the header.

## Limits of the spike

- **Direct Services get no jar.** In the Sharer's browser, a credentialed `fetch` would use
  the *Sharer's* cookie store, shared by every Guest. Not acceptable, so v1 stays as ADR 0003
  says for Direct.
- The jar keeps name and value only; `Max-Age=0` deletes. Path, domain, expiry and
  `Secure`/`SameSite` are ignored. A real jar should use a library such as `tough-cookie`.
- Jars live in the Bridge's memory and are lost when it restarts, so Guests log in again.
