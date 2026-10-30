# 06 — Does one link format survive QR, chat apps and the join?

`pnpm test 06-invite-link`

**Answer: yes.** `https://tools.sandclaw.ai/peer-share/invite#join=<blob>&from=Dirk`.
The blob is httpeers' own `encodeJoinBlob` (relay addresses, the Sharer's peer id, the
invitation id), so the existing join tooling reads it.

```ts
encodeInvite(pageUrl, { relayAddrs, sharerPeerId, invitationId, sharerName }): string
decodeInvite(link): InviteLink           // throws "This is not a PeerShare invite link…"
```

## Measured, 2026-10-30

- Round-trips everything a Guest needs.
- **The invitation stays in the fragment:** what a browser sends to the page's server is
  exactly the page URL.
- Names no Service, so an Invite admits to all of them (decision 2.3).
- Survives a QR code: `qrModules` → rendered pixels → `decodeQr` gives the same link.
- Uses only URL-safe characters, and is under 400 characters with a real relay address.
- A Guest joins with nothing but the decoded link, end to end over the mesh.

## What the rung found

**httpeers' join blob travels in a query parameter (`?join=`), which the page's server
sees and logs.** An unspent Invite is a bearer credential, so PeerShare moves the same
blob into the fragment, which browsers never send.
