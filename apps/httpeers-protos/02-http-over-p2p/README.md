# 02 — HTTP semantics over a libp2p stream

`pnpm demo:02-http-over-p2p`

Runs against the **real shipped packages** over two real libp2p 3.3.8 nodes.

## Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | A **query string survives** the round trip | `GET /echo-query?group=alpha&limit=7`; the server reflects `Object.fromEntries(url.searchParams)` and both keys are asserted | Either parameter is missing or altered |
| 2 | Multiple parameters survive together | Both `group` **and** `limit` checked, not just one | Only the first survives |
| 3 | A **streamed request body arrives complete** | A `ReadableStream` emits three parts 40 ms apart; the server reads to completion and the concatenation must equal `"alpha beta gamma"` | The body arrives empty, truncated, or reordered |
| 4 | The body arrives as **multiple chunks**, i.e. it really streamed | The server counts reads; asserted to be 3 | The body is coalesced into one chunk before transmission, which would mean it was buffered rather than streamed |
| 5 | Chunk **order** is preserved | The concatenation is compared as an ordered string | Chunks interleave or reorder |
| 6 | Unknown paths produce a normal 404 | `/` fallthrough returns `404` | A routing miss throws instead of answering |

Exit code is 0 only if both the query-string and streamed-body checks pass.

## Why this exists

These two checks are exactly the defects that made `@libp2p/http` unusable and
forced it to be replaced: the query string was never concatenated onto the
path, and a `return source` instead of `yield*` made streamed request bodies
arrive empty. Both were **silent** — the request completed with a normal status
and simply lost data. That is the worst failure shape available, and it is why
these two properties are asserted explicitly rather than assumed.

The 40 ms spacing is deliberate: it forces the chunks to arrive as separate
reads rather than being coalesced by the runtime, so claim 4 means something.

## Not covered here

- **Headers.** Only what `Response.json` sets is exercised; arbitrary
  request/response header round-tripping is not asserted.
- **Large bodies and backpressure** — see 04.
- **Abort / cancellation.** `AbortSignal` semantics are unspecified in the
  stack and untested here.
- **Response streaming.** The response bodies here are small JSON documents;
  a streamed *response* is not exercised.
