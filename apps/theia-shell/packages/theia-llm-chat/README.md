# @theia-shell/theia-llm-chat

A Theia extension for chatting with an LLM: the mesh's own LLM service (the
hub's `llm` module, LiteLLM behind it), or any OpenAI-compatible endpoint. It
is httpeers' `apps/llm-chat` (`index.html` and `mesh.html` in one) as a Theia
widget.

| Contribution | What |
|---|---|
| View *LLM Chat* (main area) | The conversations, the thread (replies stream in, rendered as Markdown), a composer with *Send*, *Stop* and *Regenerate*, and the endpoint and model pickers. |
| Commands | *LLM Chat: New Chat*, *Use the Mesh's LLM*, *Use a Custom Endpoint…*, *Create a Key for a Member…* (an admin mints a key for someone else and copies it), *Toggle LLM Chat* |

**The mesh's LLM.** When the member goes live, the chat looks for the *hub's*
`llm` advert (any other peer's is ignored), reads the hub's OpenAPI document
at `/peers/<hub>/llm/openapi.json`, and refuses any URL it names outside
`/peers/<hub>/llm/`. The service needs a key of its own: paste one, or, as an
admin, *Request a key* (`POST …/llm/keys`). The models are listed with the key
before the chat opens, so a wrong key is reported on the step that asked for it.

**Storage.** Conversations are kept in IndexedDB, in llm-chat's own `llm-chat`
database. The endpoint and key are kept per source (profiles `theia-mesh` and
`theia-custom`).

**Model output is data.** Replies are rendered with the Markdown extension's
renderer: raw HTML is escaped and the result is sanitized with DOMPurify.

`src/common/core/` and `src/common/mesh/discover.ts` are ported unchanged
from `apps/llm-chat`, together with their tests; they have no framework or
DOM in them. `src/common/chat-setup.ts` is the flow `mesh.html` and
`index.html` each implement in React, as one state machine.

Tests: `pnpm test` runs 111 unit tests: 97 ported from llm-chat (the OpenAI
client and its SSE parsing, the chat controller, the config and session stores,
discovery) and 14 for the setup flow. The e2e tests are in
[`app/tests/mesh.spec.ts`](../../app/tests/mesh.spec.ts) and
[`app/tests/chat.spec.ts`](../../app/tests/chat.spec.ts).
